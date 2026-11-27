import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import ModuleInstrumentationServer from '../../../../../module-instrumentation/src/server';
import type { InstrumentationCollectionCountRequest } from '../../../../../module-instrumentation/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainInstrumentationCountBoundary } from '../../access-control/main-instrumentation-count-boundary';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated instrumentation business count boundary', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // A direct Repository count must not reveal a selected root refused by the normal read executor.
  // 直接 Repository 统计不能泄露普通读取执行器已拒绝的选中业务根。
  it.each([false, true])('keeps raw counts behind explicit selected-table composition (guard=%s)', async (guarded) => {
    let boundary: AccessMainInstrumentationCountBoundary;
    let identity: AccessCollectionIdentity;
    let mode: 'normal' | 'async' | 'invalid' | 'throw' = 'normal';
    const selectedKeys = new Set<string>();
    const observed: InstrumentationCollectionCountRequest[] = [];
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          ModuleInstrumentationServer,
          {
            name: 'instrumentation',
            packageName: '@tachybase/module-instrumentation',
            workspaceSource: true,
            collectionCountGuard: guarded
              ? (request: InstrumentationCollectionCountRequest) => {
                  observed.push(request);
                  if (mode === 'async') return Promise.resolve() as never;
                  if (mode === 'invalid') return false as never;
                  if (mode === 'throw') throw new Error('Instrumentation guard refused');
                  return boundary.assert(request, selectedKeys.has(identity.collectionKey) ? [identity] : []);
                }
              : undefined,
          },
        ],
      ],
    });
    boundary = new AccessMainInstrumentationCountBoundary(app);
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'instrumentation-business-editor';
    const password = 'instrumentation-business-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const collectionName = 'instrumentationBusinessTasks';
    const stored = await app.db.getRepository('collections').create({
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
          { name: 'create', fields: ['name'] },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(actions.map((action) => action.get('name')).sort()).toEqual(['create', 'list']);
    for (const action of actions)
      expect([...action.get('fields')].sort()).toEqual(
        action.get('name') === 'list' ? ['id', 'name', 'tenantId'] : ['name'],
      );
    const collection = app.db.getCollection(collectionName);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    await registry.store.save(
      identity,
      { ...configFor(ownerCondition), revision: 0, rules: [] },
      { userId: user.get('id') },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${signedIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(user.get('id')));
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Known harmless task' } });
    expect(created.status).toBe(200);
    expect(await rows()).toEqual([{ id: 1, name: 'Known harmless task', tenantId: 'B' }]);
    const visible = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([{ id: 1, name: 'Known harmless task', tenantId: 'B' }]);
    await app.db.getRepository('statisticsConfig').create({
      values: {
        title: 'Known task count',
        statisticsOptions: { collection: collectionName, collectionFilter: { id: 1 } },
      },
    });
    const baseline = await agent().get('/instrumentation:list');
    expect(baseline.status).toBe(200);
    expect(baseline.body.data.customData).toEqual({ 'Known task count': 1 });
    if (guarded) {
      const captured = observed.at(-1)!;
      expect(Object.isFrozen(captured)).toBe(true);
      expect(captured.collection).toBe(collection);
      expect(captured.params).toEqual({ filter: { id: 1 } });
      expect(String(captured.context.state.currentUser.id)).toBe(String(user.get('id')));
      expect(captured.context.state.currentRole).toBe(role);
      expect(captured.context.state.currentTenantId).toBe('B');
      expect(() => boundary.assert({ ...captured, collection: {} }, [identity])).toThrow(/target changed/);
      expect(() => boundary.assert(captured, [identity, identity])).toThrow(/table selection/);
    }
    const plugin = app.pm.get('instrumentation') as ModuleInstrumentationServer;
    plugin.options.collectionCountGuard = () => {};
    selectedKeys.add(identity.collectionKey);
    const protectedList = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(protectedList.status).toBe(200);
    expect(protectedList.body.data).toEqual([]);
    let rawCounts = 0;
    let failCount = false;
    collection.model.addHook('beforeCount', () => {
      rawCounts++;
      if (failCount) throw new Error('Test business count failed');
    });
    const protectedCount = await agent().get('/instrumentation:list');
    if (!guarded) {
      // The plugin alone deliberately retains its original path; server composition owns opt-in.
      // 插件单独使用仍保留旧路径，由服务端显式组合选择接入。
      expect(protectedCount.status).toBe(200);
      expect(protectedCount.body.data.customData).toEqual({ 'Known task count': 1 });
      expect(rawCounts).toBe(1);
      expect(await rows()).toEqual([{ id: 1, name: 'Known harmless task', tenantId: 'B' }]);
      return;
    }
    expect(protectedCount.status, JSON.stringify(protectedCount.body)).toBe(400);
    expect(protectedCount.body.data).toBeUndefined();
    expect(rawCounts).toBe(0);
    for (const invalidMode of ['async', 'invalid', 'throw'] as const) {
      mode = invalidMode;
      const refused = await agent().get('/instrumentation:list');
      expect(refused.status).toBe(500);
      expect(refused.body.data).toBeUndefined();
      expect(rawCounts).toBe(0);
    }
    mode = 'normal';
    selectedKeys.clear();
    const unchangedLegacy = await agent().get('/instrumentation:list');
    expect(unchangedLegacy.status).toBe(200);
    expect(unchangedLegacy.body.data.customData).toEqual({ 'Known task count': 1 });
    expect(rawCounts).toBe(1);
    failCount = true;
    const legacyFailure = await agent().get('/instrumentation:list');
    expect(legacyFailure.status).toBe(200);
    expect(legacyFailure.body.data.customData).toEqual({ 'Known task count': 0 });
    expect(rawCounts).toBe(2);
    plugin.options.collectionCountGuard = false as never;
    await expect(plugin.beforeLoad()).rejects.toThrow(/must be a function/);
    expect(await rows()).toEqual([{ id: 1, name: 'Known harmless task', tenantId: 'B' }]);
  });
});
