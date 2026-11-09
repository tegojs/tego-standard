import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated direct resource field grants on root writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let token: string;
  const collectionName = 'fieldGrantTasks';
  const roles = ['field-narrow', 'field-full', 'field-no-action'];
  const account = 'resource-field-writer';
  const password = 'resource-field-test-password';
  const agent = (role: string) =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');
  const write = (role: string, action: 'create' | 'update', values: { name?: string; amount?: number }) =>
    action === 'create'
      ? agent(role).resource(collectionName).create({ values })
      : agent(role).resource(collectionName).update({ filterByTk: 1, values });

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    for (const name of roles)
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles, tenants: ['B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collection = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
        ],
      },
    });
    for (const roleName of roles.slice(0, 2))
      await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName,
          name: collectionName,
          usingActionsConfig: true,
          actions: ['create', 'update'].map((name) => ({
            name,
            fields: roleName === 'field-narrow' ? ['name'] : ['name', 'amount'],
          })),
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
        rules: roles.map((roleName) => ({
          ...config.rules[0],
          id: roleName,
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
                right: { type: 'literal', value: roleName },
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
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
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

  // Dropping the final ACL whitelist or replacing it with G must break these persisted outcomes.
  // 最终字段白名单丢失或被 G 替代时，真实持久结果必须让测试失败。
  it.each([
    {
      action: 'create',
      afterNarrow: [
        { id: 1, name: 'Initial row', amount: 10, tenantId: 'B' },
        { id: 2, name: 'Narrow write', amount: null, tenantId: 'B' },
      ],
      afterFull: [
        { id: 1, name: 'Initial row', amount: 10, tenantId: 'B' },
        { id: 2, name: 'Narrow write', amount: null, tenantId: 'B' },
        { id: 3, name: 'Full write', amount: 40, tenantId: 'B' },
      ],
    },
    {
      action: 'update',
      afterNarrow: [{ id: 1, name: 'Narrow write', amount: 10, tenantId: 'B' }],
      afterFull: [{ id: 1, name: 'Full write', amount: 40, tenantId: 'B' }],
    },
  ] as const)(
    'projects $action values through persisted direct field grants independently of G',
    async ({ action, afterNarrow, afterFull }) => {
      const tasks = app.db.getCollection(collectionName);
      const rows = () => tasks.model.findAll({ raw: true, order: [['id', 'ASC']] });
      const grants = await app.db.getRepository('dataSourcesRolesResources').find({
        filter: { dataSourceKey: 'main', name: collectionName },
        appends: ['actions'],
        sort: ['roleName'],
      });
      expect(
        grants.map((grant) => ({
          roleName: grant.get('roleName'),
          usingActionsConfig: grant.get('usingActionsConfig'),
          actions: grant
            .get('actions')
            .map((entry) => ({ name: entry.get('name'), fields: [...entry.get('fields')].sort() }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        })),
      ).toEqual([
        {
          roleName: 'field-full',
          usingActionsConfig: true,
          actions: [
            { name: 'create', fields: ['amount', 'name'] },
            { name: 'update', fields: ['amount', 'name'] },
          ],
        },
        {
          roleName: 'field-narrow',
          usingActionsConfig: true,
          actions: [
            { name: 'create', fields: ['name'] },
            { name: 'update', fields: ['name'] },
          ],
        },
      ]);
      expect(await rows()).toEqual([]);
      expect((await write('field-full', 'create', { name: 'Initial row', amount: 10 })).status).toBe(200);
      expect(await rows()).toEqual([{ id: 1, name: 'Initial row', amount: 10, tenantId: 'B' }]);
      expect((await write('field-narrow', action, { name: 'Narrow write', amount: 30 })).status).toBe(200);
      expect(await rows()).toEqual(afterNarrow);
      if (action === 'update') {
        const noFields = await write('field-narrow', 'update', { amount: 35 });
        expect(noFields.status).toBe(400);
        expect(noFields.body.errors[0].message).toContain('No authorized fields to update');
        expect(await rows()).toEqual(afterNarrow);
      }
      expect((await write('field-no-action', action, { name: 'No action', amount: 50 })).status).toBe(403);
      expect(await rows()).toEqual(afterNarrow);
      expect((await write('field-full', action, { name: 'Full write', amount: 40 })).status).toBe(200);
      expect(await rows()).toEqual(afterFull);
    },
  );
});
