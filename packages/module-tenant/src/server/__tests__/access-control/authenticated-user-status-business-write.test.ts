import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { Plugin } from '@tego/server';

import type { PluginAuthServer } from '../../../../../module-auth/src/server/plugin';
import { UserStatusService } from '../../../../../module-auth/src/server/user-status';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

// Install the production service before the helper's fixed-active fallback can run.
// 在测试工具的固定 active 替身之前显式组合生产状态服务；不代表正式安装验收。
class PersistedUserStatusPlugin extends Plugin {
  async load() {
    const auth = this.app.pm.get('auth') as PluginAuthServer;
    this.app.authManager.setUserStatusService(
      new UserStatusService({ cache: auth.cache, app: this.app, logger: this.app.logger }),
    );
  }
}

describe.skipIf(!coreEntry)('authenticated business writes with persisted user status', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  const role = 'status-business-editor';
  const collectionName = 'statusBusinessTasks';
  const password = 'status-business-test-password';

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [PersistedUserStatusPlugin],
    });
    expect(app.authManager.userStatusService).toBeInstanceOf(UserStatusService);
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const statuses = app.db.getRepository('userStatuses');
    for (const values of [
      { key: 'active', title: 'Active', allowLogin: true, loginErrorMessage: null },
      { key: 'pending', title: 'Pending', allowLogin: false, loginErrorMessage: 'Account awaiting approval' },
    ]) {
      await statuses.updateOrCreate({ filterKeys: ['key'], values });
    }
    expect(
      await statuses.find({
        filter: { key: { $in: ['active', 'pending'] } },
        fields: ['key', 'allowLogin'],
        sort: ['key'],
        raw: true,
      }),
    ).toEqual([
      { key: 'active', allowLogin: 1 },
      { key: 'pending', allowLogin: 0 },
    ]);
    await app.db.getRepository('collections').create({
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
  });

  async function createAccount(status: 'active' | 'pending') {
    const account = `status-business-${status}`;
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, status, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const persisted = await app.db.getRepository('users').findOne({ filterByTk: userId });
    expect(persisted.get('status')).toBe(status);
    expect(persisted.get('statusExpireAt')).toBeNull();
    expect(persisted.get('defaultTenantId')).toBe('B');
    const memberships = await app.db.getRepository('tenantUsers').find({ filter: { userId } });
    expect(memberships.map((membership) => membership.get('tenantId'))).toEqual(['B']);
    const collection = await app.db.getRepository('collections').findOne({ filter: { name: collectionName } });
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
    return { account, userId };
  }

  // Replacing persisted status checks with a fixed result must break these controls.
  // 固定放行或固定拒绝替代持久状态检查时，这两项真实认证控制必须失败。
  it('allows an initially active password account to complete tenant business CRUD', async () => {
    const { account, userId } = await createAccount('active');
    const service = app.authManager.userStatusService as UserStatusService;
    expect(await service.getUserStatusFromCache(userId)).toBeNull();
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, status: 'active', hasPassword: true });
    expect(await service.getUserStatusFromCache(userId)).toMatchObject({ userId, status: 'active', expireAt: null });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = () =>
      app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', role);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ id: userId, status: 'active', hasPassword: true });
    const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Active draft' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Active draft', tenantId: 'B' }]);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([{ id: 1, name: 'Active draft', tenantId: 'B' }]);
    const fetched = await agent()
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(fetched.status).toBe(200);
    expect(fetched.body.data).toEqual({ id: 1, name: 'Active draft', tenantId: 'B' });
    const updated = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Active edit' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Active edit', tenantId: 'B' }]);
    const removed = await agent().resource(collectionName).destroy({ filterByTk: 1 });
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([]);
    const finalList = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(finalList.status).toBe(200);
    expect(finalList.body.data).toEqual([]);
    expect((await app.db.getRepository('users').findOne({ filterByTk: userId })).get('status')).toBe('active');
  });

  it('refuses an initially pending password account without issuing a business credential', async () => {
    const { account, userId } = await createAccount('pending');
    const service = app.authManager.userStatusService as UserStatusService;
    expect(await service.getUserStatusFromCache(userId)).toBeNull();
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(401);
    expect(signedIn.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'USER_STATUS_NOT_ALLOW_LOGIN' })]),
    );
    expect(signedIn.body.data).toBeUndefined();
    expect(await service.getUserStatusFromCache(userId)).toMatchObject({ userId, status: 'pending', expireAt: null });
    expect(await app.db.getCollection(collectionName).model.findAll({ raw: true })).toEqual([]);
    expect((await app.db.getRepository('users').findOne({ filterByTk: userId })).get('status')).toBe('pending');
  });
});
