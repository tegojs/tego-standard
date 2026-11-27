import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated root writes with failing business hooks', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let token: string;
  let userId: number;
  const role = 'rollback-writer';
  const password = 'business-hook-test-password';
  const collectionName = 'hookRollbackTasks';
  const write = (action: 'create' | 'update', name: string) => {
    const resource = app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B')
      .resource(collectionName);
    return action === 'create'
      ? resource.create({ values: { name } })
      : resource.update({ filterByTk: 1, values: { name } });
  };

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['create', 'update'] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    userId = user.get('id');
    const collection = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    const identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: config.rules.map((rule) => ({
          ...rule,
          subject: {
            type: 'all',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(userId) },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: role },
              },
            ],
          },
        })),
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Losing the owned transaction or swallowing the late hook error must expose persisted writes here.
  // 丢失所属事务或吞掉后置 hook 异常时，真实持久结果必须让测试失败。
  it.each([
    {
      action: 'create',
      tentative: [
        { id: 1, name: 'Initial row', tenantId: 'B' },
        { id: 2, name: 'Requested write', tenantId: 'B' },
      ],
    },
    { action: 'update', tentative: [{ id: 1, name: 'Requested write', tenantId: 'B' }] },
  ] as const)(
    'rolls back $action after SQL when the association-complete hook rejects',
    async ({ action, tentative }) => {
      const tasks = app.db.getCollection(collectionName);
      const rows = () => tasks.model.findAll({ raw: true, order: [['id', 'ASC']], transaction: null });
      expect(await rows()).toEqual([]);
      expect((await write('create', 'Initial row')).status).toBe(200);
      expect(await rows()).toEqual([{ id: 1, name: 'Initial row', tenantId: 'B' }]);
      let reject = true;
      let committed = 0;
      const observed: { transaction: Transaction; rows: unknown; actor: unknown }[] = [];
      const event = `${collectionName}.${action === 'create' ? 'afterCreate' : 'afterUpdate'}WithAssociations`;
      app.db.on(event, async (_record, options) => {
        const transaction: Transaction = options.transaction;
        observed.push({
          transaction,
          rows: await tasks.model.findAll({ raw: true, order: [['id', 'ASC']], transaction }),
          actor: {
            userId: options.context.state.currentUser.id,
            role: options.context.state.currentRole,
            tenantId: options.context.state.currentTenantId,
          },
        });
        transaction.afterCommit(() => {
          committed++;
        });
        if (reject) throw new Error('Late authenticated business hook rejection');
      });
      const failed = await write(action, 'Requested write');
      expect(failed.status).toBe(500);
      expect(failed.body.errors[0].message).toContain('Late authenticated business hook rejection');
      expect(observed).toHaveLength(1);
      expect(observed[0].rows).toEqual(tentative);
      expect(observed[0].actor).toEqual({ userId, role, tenantId: 'B' });
      expect(observed[0].transaction.finished).toBe('rollback');
      expect(committed).toBe(0);
      expect(await rows()).toEqual([{ id: 1, name: 'Initial row', tenantId: 'B' }]);
      reject = false;
      expect((await write(action, 'Requested write')).status).toBe(200);
      expect(observed).toHaveLength(2);
      expect(observed[1].rows).toEqual(tentative);
      expect(observed[1].actor).toEqual({ userId, role, tenantId: 'B' });
      expect(observed[1].transaction).not.toBe(observed[0].transaction);
      expect(observed[1].transaction.finished).toBe('commit');
      expect(committed).toBe(1);
      expect(await rows()).toEqual(tentative);
    },
  );
});
