import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated shared business records', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Shared storage must not require tenant state or turn G into an action permission.
  // 共享存储不能要求租户上下文，也不能用 G 替代动作权限。
  it('supports ordinary shared record edits without tenant membership while retaining action ACL', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    const collectionName = 'sharedBusinessTasks';
    const role = 'shared-task-editor';
    const deniedRole = 'shared-task-without-actions';
    for (const name of [role, deniedRole])
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const account = 'shared-task-user';
    const password = 'shared-task-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: [role, deniedRole], tenants: [], defaultTenantId: null },
    });
    const userId = user.get('id');
    expect(await app.db.getRepository('tenantUsers').count({ filter: { userId } })).toBe(0);
    expect((await app.db.getRepository('users').findOne({ filterByTk: userId })).get('defaultTenantId')).toBeNull();
    const collection = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'shared',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    const model = app.db.getCollection(collectionName).model;
    expect(Object.hasOwn(model.rawAttributes, 'tenantId')).toBe(false);
    const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name'] },
          { name: 'get', fields: ['id', 'name'] },
          { name: 'create', fields: ['name'] },
          { name: 'update', fields: ['name'] },
          { name: 'destroy' },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(
      actions
        .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name'] },
      { name: 'destroy', fields: [] },
      { name: 'get', fields: ['id', 'name'] },
      { name: 'list', fields: ['id', 'name'] },
      { name: 'update', fields: ['name'] },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor({ type: 'constant', value: true });
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        ownership: { enabled: false },
        rules: [
          {
            ...config.rules[0],
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
                  type: 'any',
                  children: [role, deniedRole].map((name) => ({
                    type: 'compare',
                    operator: 'eq',
                    left: { type: 'context', path: 'role.name' },
                    right: { type: 'literal', value: name },
                  })),
                },
              ],
            },
          },
        ],
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    const observed: Array<{ userId: number; tenantId: unknown; currentTenant: unknown }> = [];
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => {
      if (ctx.action.resourceName === collectionName)
        observed.push({
          userId: ctx.state.currentUser?.id,
          tenantId: ctx.state.currentTenantId,
          currentTenant: ctx.state.currentTenant,
        });
      return registry.select(ctx, adapter, [identity.collectionKey]);
    });
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (roleName = role) =>
      app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', roleName);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(userId);
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Shared draft' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Shared draft' }]);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name'], sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([{ id: 1, name: 'Shared draft' }]);
    const detail = await agent()
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name'] });
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual({ id: 1, name: 'Shared draft' });
    const denied = await agent(deniedRole)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Unpermitted edit' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual([{ id: 1, name: 'Shared draft' }]);
    const updated = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Shared edit' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Shared edit' }]);
    const destroyed = await agent().resource(collectionName).destroy({ filterByTk: 1 });
    expect(destroyed.status).toBe(200);
    expect(destroyed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([]);
    expect(observed).toHaveLength(6);
    for (const state of observed) {
      expect(state.userId).toBe(userId);
      expect(state.tenantId == null).toBe(true);
      expect(state.currentTenant == null).toBe(true);
    }
  });
});
