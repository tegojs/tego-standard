import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated role revocation before root writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let userId: number;
  let token: string;
  const role = 'revocable-writer';
  const deniedRole = 'unprivileged-member';
  const password = 'role-revocation-test-password';
  const collectionName = 'roleRevocationTasks';
  const agent = (roleName = role) =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', roleName)
      .set('X-Tenant-Id', 'B');

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    for (const [name, actions] of [
      [role, ['create', 'update']],
      [deniedRole, []],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions }, snippets: [] } });
    }
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role, deniedRole], tenants: ['B'], defaultTenantId: 'B' },
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
    { scenario: 'another unprivileged role remains', keepOtherRole: true, code: 'ROLE_NOT_FOUND_ERR' },
    { scenario: 'no roles remain', keepOtherRole: false, code: 'USER_HAS_NO_ROLES_ERR' },
  ])('rejects the same Bearer after revocation when $scenario', async ({ keepOtherRole, code }) => {
    const tasks = app.db.getCollection(collectionName);
    expect(await tasks.model.findAll({ raw: true })).toEqual([]);
    expect(
      (
        await agent()
          .resource(collectionName)
          .create({ values: { name: 'Before revocation' } })
      ).status,
    ).toBe(200);
    expect(
      (
        await agent()
          .resource(collectionName)
          .update({ filterByTk: 1, values: { name: 'Warmed membership' } })
      ).status,
    ).toBe(200);
    expect(await tasks.model.findAll({ raw: true })).toEqual([{ id: 1, name: 'Warmed membership', tenantId: 'B' }]);
    expect(await app.cache.get(`roles:${userId}`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: role })]),
    );

    await app.db.getRepository('rolesUsers').destroy({
      filter: { userId, roleName: { $in: keepOtherRole ? [role] : [role, deniedRole] } },
    });
    expect(
      await app.db.getCollection('rolesUsers').model.findAll({
        where: { userId },
        attributes: ['roleName'],
        raw: true,
      }),
    ).toEqual(keepOtherRole ? [{ roleName: deniedRole }] : []);

    const observers = [
      vi.spyOn(tasks.repository, 'create'),
      vi.spyOn(tasks.repository, 'update'),
      vi.spyOn(tasks.repository, 'find'),
      vi.spyOn(tasks.repository, 'findOne'),
    ];
    try {
      for (const response of [
        await agent()
          .resource(collectionName)
          .create({ values: { name: 'Rejected create' } }),
        await agent()
          .resource(collectionName)
          .update({ filterByTk: 1, values: { name: 'Rejected update' } }),
      ]) {
        expect(response.status).toBe(401);
        expect(response.body.errors[0].code).toBe(code);
      }
      if (keepOtherRole) {
        expect(
          (
            await agent(deniedRole)
              .resource(collectionName)
              .create({ values: { name: 'No action grant' } })
          ).status,
        ).toBe(403);
      }
      for (const observer of observers) expect(observer).not.toHaveBeenCalled();
      expect(await tasks.model.findAll({ raw: true })).toEqual([{ id: 1, name: 'Warmed membership', tenantId: 'B' }]);
    } finally {
      for (const observer of observers) observer.mockRestore();
    }

    await app.db.getRepository('rolesUsers').create({ values: { userId, roleName: role } });
    expect(
      (
        await agent()
          .resource(collectionName)
          .create({ values: { name: 'After restoration' } })
      ).status,
    ).toBe(200);
    expect(
      (
        await agent()
          .resource(collectionName)
          .update({ filterByTk: 1, values: { name: 'Restored writer' } })
      ).status,
    ).toBe(200);
    expect(await tasks.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual([
      { id: 1, name: 'Restored writer', tenantId: 'B' },
      { id: 2, name: 'After restoration', tenantId: 'B' },
    ]);
  });
});
