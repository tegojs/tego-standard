import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated role strategy changes before root writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let userId: number;
  let token: string;
  const role = 'strategy-writer';
  const password = 'role-strategy-test-password';
  const collectionName = 'roleStrategyTasks';
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');
  const write = (action: 'create' | 'update', name: string) =>
    action === 'create'
      ? agent().resource(collectionName).create({ values: { name } })
      : agent().resource(collectionName).update({ filterByTk: 1, values: { name } });

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

  it.each([
    {
      revoked: 'create',
      retained: 'update',
      afterRetained: [{ id: 1, name: 'Retained update', tenantId: 'B' }],
      afterRestored: [
        { id: 1, name: 'Retained update', tenantId: 'B' },
        { id: 2, name: 'Restored create', tenantId: 'B' },
      ],
    },
    {
      revoked: 'update',
      retained: 'create',
      afterRetained: [
        { id: 1, name: 'Warmed actions', tenantId: 'B' },
        { id: 2, name: 'Retained create', tenantId: 'B' },
      ],
      afterRestored: [
        { id: 1, name: 'Restored update', tenantId: 'B' },
        { id: 2, name: 'Retained create', tenantId: 'B' },
      ],
    },
  ] as const)(
    'applies persisted $revoked revocation without losing $retained or changing the Bearer',
    async ({ revoked, retained, afterRetained, afterRestored }) => {
      const tasks = app.db.getCollection(collectionName);
      const roles = app.db.getRepository('roles');
      const memberships = () => app.db.getCollection('rolesUsers').model.findAll({ where: { userId }, raw: true });
      const strategy = async () => (await roles.findOne({ filterByTk: role })).get('strategy');
      const mainStrategy = async () =>
        (
          await app.db.getRepository('dataSourcesRoles').findOne({
            filter: { roleName: role, dataSourceKey: 'main' },
          })
        ).get('strategy');
      expect(await tasks.model.findAll({ raw: true })).toEqual([]);
      expect((await write('create', 'Before strategy change')).status).toBe(200);
      expect((await write('update', 'Warmed actions')).status).toBe(200);
      expect(await tasks.model.findAll({ raw: true })).toEqual([{ id: 1, name: 'Warmed actions', tenantId: 'B' }]);
      const originalMemberships = await memberships();
      expect(originalMemberships).toEqual([expect.objectContaining({ userId, roleName: role })]);
      expect(await app.cache.get(`roles:${userId}`)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: role })]),
      );

      await roles.update({ filterByTk: role, values: { strategy: { actions: [retained] } } });
      expect(await strategy()).toEqual({ actions: [retained] });
      expect(await mainStrategy()).toEqual({ actions: [retained] });
      expect(await memberships()).toEqual(originalMemberships);

      const observers = [
        vi.spyOn(tasks.repository, 'create'),
        vi.spyOn(tasks.repository, 'update'),
        vi.spyOn(tasks.repository, 'find'),
        vi.spyOn(tasks.repository, 'findOne'),
      ];
      try {
        expect((await write(revoked, 'Rejected action')).status).toBe(403);
        for (const observer of observers) expect(observer).not.toHaveBeenCalled();
        expect(await tasks.model.findAll({ raw: true })).toEqual([{ id: 1, name: 'Warmed actions', tenantId: 'B' }]);
      } finally {
        for (const observer of observers) observer.mockRestore();
      }

      expect((await write(retained, `Retained ${retained}`)).status).toBe(200);
      expect(await tasks.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(afterRetained);
      await roles.update({ filterByTk: role, values: { strategy: { actions: ['create', 'update'] } } });
      expect(await strategy()).toEqual({ actions: ['create', 'update'] });
      expect(await mainStrategy()).toEqual({ actions: ['create', 'update'] });
      expect(await memberships()).toEqual(originalMemberships);
      expect((await write(revoked, `Restored ${revoked}`)).status).toBe(200);
      expect(await tasks.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(afterRestored);
    },
  );
});
