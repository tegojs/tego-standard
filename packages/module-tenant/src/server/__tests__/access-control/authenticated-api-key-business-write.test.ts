import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import PluginAPIKeysServer from '../../../../../plugin-api-keys/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated API key business writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Losing key-role binding, bypassing action ACL, or dropping tenant scope must break these stored results.
  // 丢失密钥绑定角色、用认证替代动作 ACL 或忽略租户范围时，完整持久结果必须不再通过。
  it('uses HTTP-issued valid keys with their bound roles and actual tenant ownership', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [PluginAPIKeysServer, { name: 'api-keys', packageName: '@tachybase/plugin-api-keys', workspaceSource: true }],
      ],
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'B', name: 'B', enabled: true },
        { id: 'C', name: 'C', enabled: true },
      ],
    });
    const issuer = 'business-key-issuer';
    const writer = 'api-business-writer';
    const reader = 'api-business-reader';
    await app.db.getRepository('roles').create({
      values: [
        { name: issuer, strategy: { actions: [] }, snippets: ['pm.api-keys.configuration'] },
        { name: writer, strategy: { actions: [] }, snippets: [] },
        { name: reader, strategy: { actions: [] }, snippets: [] },
      ],
    });
    const password = 'api-business-test-password';
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'api-business-user',
        password,
        roles: [issuer, writer, reader],
        tenants: ['B', 'C'],
        defaultTenantId: 'B',
      },
    });
    const userId = user.get('id');
    const collectionName = 'apiBusinessTasks';
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
    const model = app.db.getCollection(collectionName).model;
    for (const roleName of [writer, reader]) {
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
            { name: 'get', fields: ['id', 'name', 'tenantId'] },
            ...(roleName === writer
              ? [{ name: 'create', fields: ['name'] }, { name: 'update', fields: ['name'] }, { name: 'destroy' }]
              : []),
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        roleName === writer
          ? [
              { name: 'create', fields: ['name'] },
              { name: 'destroy', fields: [] },
              { name: 'get', fields: ['id', 'name', 'tenantId'] },
              { name: 'list', fields: ['id', 'name', 'tenantId'] },
              { name: 'update', fields: ['name'] },
            ]
          : [
              { name: 'get', fields: ['id', 'name', 'tenantId'] },
              { name: 'list', fields: ['id', 'name', 'tenantId'] },
            ],
      );
    }
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: 'api-business-user', password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const sessionToken = signedIn.body.data.token;
    expect(sessionToken).toEqual(expect.any(String));
    const keys = new Map<string, string>();
    for (const roleName of [writer, reader]) {
      const issued = await app
        .agent()
        .set('Authorization', `Bearer ${sessionToken}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', issuer)
        .set('X-Tenant-Id', 'B')
        .resource('apiKeys')
        .create({ values: { name: roleName, role: { name: roleName }, expiresIn: '1d' } });
      expect(issued.status).toBe(200);
      const token = issued.body.data.token;
      expect(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)).toBe(true);
      const persisted = await app.db.getRepository('apiKeys').findOne({ filter: { accessToken: token } });
      expect(persisted).toBeTruthy();
      expect(persisted.get('createdById')).toBe(userId);
      expect(persisted.get('roleName')).toBe(roleName);
      const payload = await app.authManager.jwt.decode(persisted.get('token'));
      expect(payload).toMatchObject({ userId, roleName });
      keys.set(roleName, token);
    }
    const identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: [writer, reader].flatMap((roleName) =>
          config.rules.map((rule) => ({
            ...rule,
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
        ),
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    const observed: Array<{ userId: unknown; roleName: unknown; tenantId: unknown }> = [];
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => {
      if (ctx.action.resourceName === collectionName)
        observed.push({
          userId: ctx.state.currentUser?.id,
          roleName: ctx.state.currentRole,
          tenantId: ctx.state.currentTenantId,
        });
      return registry.select(ctx, adapter, [identity.collectionKey]);
    });
    const agent = (roleName = writer, tenantId = 'B') =>
      app
        .agent()
        .set('Authorization', `Bearer ${keys.get(roleName)}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', issuer)
        .set('X-Tenant-Id', tenantId);
    for (const roleName of [writer, reader]) {
      const checked = await agent(roleName).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: userId, hasPassword: true });
    }
    const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const first = await agent()
      .resource(collectionName)
      .create({ values: { name: 'API draft' } });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ keys: [1], affected: 1 });
    const second = await agent(writer, 'C')
      .resource(collectionName)
      .create({ values: { name: 'API C draft' } });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ keys: [2], affected: 1 });
    const before = [
      { id: 1, name: 'API draft', tenantId: 'B' },
      { id: 2, name: 'API C draft', tenantId: 'C' },
    ];
    expect(await rows()).toEqual(before);
    const listed = await agent(reader)
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'], sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([{ id: 1, name: 'API draft', tenantId: 'B' }]);
    const fetched = await agent(reader)
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(fetched.status).toBe(200);
    expect(fetched.body.data).toEqual({ id: 1, name: 'API draft', tenantId: 'B' });
    const deniedRole = await agent(reader)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Reader cannot edit' } });
    expect(deniedRole.status).toBe(403);
    expect(await rows()).toEqual(before);
    const deniedTenant = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'B cannot edit C' } });
    expect(deniedTenant.status).toBe(403);
    expect(await rows()).toEqual(before);
    const updated = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'API edited' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'API edited', tenantId: 'B' },
      { id: 2, name: 'API C draft', tenantId: 'C' },
    ]);
    const destroyed = await agent().resource(collectionName).destroy({ filterByTk: 1 });
    expect(destroyed.status).toBe(200);
    expect(destroyed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 2, name: 'API C draft', tenantId: 'C' }]);
    const finalList = await agent(reader)
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(finalList.status).toBe(200);
    expect(finalList.body.data).toEqual([]);
    expect(observed).toEqual([
      { userId, roleName: writer, tenantId: 'B' },
      { userId, roleName: writer, tenantId: 'C' },
      { userId, roleName: reader, tenantId: 'B' },
      { userId, roleName: reader, tenantId: 'B' },
      { userId, roleName: reader, tenantId: 'B' },
      { userId, roleName: writer, tenantId: 'B' },
      { userId, roleName: writer, tenantId: 'B' },
      { userId, roleName: writer, tenantId: 'B' },
      { userId, roleName: reader, tenantId: 'B' },
    ]);
    expect(await app.db.getRepository('apiKeys').count()).toBe(2);
  });
});
