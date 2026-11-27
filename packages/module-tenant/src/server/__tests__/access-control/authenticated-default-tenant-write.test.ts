import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated default tenant business writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Ignoring the persisted default or reusing the previous header tenant must break this lifecycle.
  // 忽略持久默认租户或沿用上次请求头租户时，本生命周期验收必须失败。
  it('uses the accessible persisted default for headerless CRUD after an explicit tenant request', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'A', name: 'A', enabled: true },
        { id: 'B', name: 'B', enabled: true },
      ],
    });
    const role = 'tenant-context-editor';
    const account = 'tenant-context-user';
    const password = 'tenant-context-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: [role], tenants: ['A', 'B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    expect((await app.db.getRepository('users').findOne({ filterByTk: userId })).get('defaultTenantId')).toBe('B');
    const memberships = await app.db.getRepository('tenantUsers').find({ filter: { userId } });
    expect(memberships.map((membership) => membership.get('tenantId')).sort()).toEqual(['A', 'B']);
    const collectionName = 'tenantContextTasks';
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
    expect(Object.hasOwn(model.rawAttributes, 'tenantId')).toBe(true);
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
          { name: 'get', fields: ['id', 'name', 'tenantId'] },
          { name: 'create', fields: ['name'] },
          { name: 'update', fields: ['name'] },
          { name: 'destroy' },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(
      actions
        .map((action) => ({ name: action.get('name'), fields: action.get('fields') }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name'] },
      { name: 'destroy', fields: [] },
      { name: 'get', fields: ['id', 'name', 'tenantId'] },
      { name: 'list', fields: ['id', 'name', 'tenantId'] },
      { name: 'update', fields: ['name'] },
    ]);
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
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (tenantId?: string) => {
      const request = app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role);
      return tenantId ? request.set('X-Tenant-Id', tenantId) : request;
    };
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ id: userId, hasPassword: true });
    const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Tenant draft' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Tenant draft', tenantId: 'B' }]);
    const other = await agent('A')
      .resource(collectionName)
      .create({ values: { name: 'Explicit A draft' } });
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual({ keys: [2], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Tenant draft', tenantId: 'B' },
      { id: 2, name: 'Explicit A draft', tenantId: 'A' },
    ]);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'], sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([{ id: 1, name: 'Tenant draft', tenantId: 'B' }]);
    const fetched = await agent()
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(fetched.status).toBe(200);
    expect(fetched.body.data).toEqual({ id: 1, name: 'Tenant draft', tenantId: 'B' });
    const denied = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Wrong tenant edit' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual([
      { id: 1, name: 'Tenant draft', tenantId: 'B' },
      { id: 2, name: 'Explicit A draft', tenantId: 'A' },
    ]);
    const updated = await agent()
      .resource(collectionName)
      .update({
        filterByTk: 1,
        values: { name: 'Tenant edit' },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Tenant edit', tenantId: 'B' },
      { id: 2, name: 'Explicit A draft', tenantId: 'A' },
    ]);
    const removed = await agent().resource(collectionName).destroy({ filterByTk: 1 });
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 2, name: 'Explicit A draft', tenantId: 'A' }]);
    const finalList = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(finalList.status).toBe(200);
    expect(finalList.body.data).toEqual([]);
  });
});
