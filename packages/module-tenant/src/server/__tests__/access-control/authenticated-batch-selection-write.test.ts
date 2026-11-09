import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated batch selection contracts', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Silently dropping an explicit key must fail; filter selection must retain the persisted role scope.
  // 显式选中不能静默丢弃不可写记录；条件选中也不能越过真实持久角色范围。
  it.each(['update', 'destroy'] as const)(
    'distinguishes explicit selection from scoped filter selection for %s',
    async (operation) => {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      const role = 'batch-task-editor';
      const password = 'batch-selection-test-password';
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      const collectionName = 'batchSelectionTasks';
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
          ],
        },
      });
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          dataSourceKey: 'main',
          name: 'Draft tasks',
          resourceName: collectionName,
          scope: { stage: { $eq: 'draft' } },
        },
      });
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'] },
            { name: 'create', fields: ['name', 'stage'] },
            {
              name: operation,
              ...(operation === 'update' ? { fields: ['name'] } : {}),
              scope: { id: scope.get('id') },
            },
          ],
        },
      });
      const actions = await resource.getActions({ include: ['scope'] });
      expect(
        actions
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
            filter: action.get('scope')?.get('scope') ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(
        [
          { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'], filter: null },
          { name: 'create', fields: ['name', 'stage'], filter: null },
          {
            name: operation,
            fields: operation === 'update' ? ['name'] : [],
            filter: { stage: { $eq: 'draft' } },
          },
        ].sort((a, b) => a.name.localeCompare(b.name)),
      );
      const registry = new AccessMainRootResourceRegistry(app);
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const config = configFor({
        type: 'all',
        children: [
          ownerCondition,
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'context', path: 'user.id' },
            right: { type: 'literal', value: String(user.get('id')) },
          },
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'context', path: 'role.name' },
            right: { type: 'literal', value: role },
          },
        ],
      });
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.get('id') });
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
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      for (const values of [
        { name: 'First draft', stage: 'draft' },
        { name: 'Second draft', stage: 'draft' },
        { name: 'Third draft', stage: 'draft' },
        { name: 'Submitted task', stage: 'submitted' },
      ]) {
        const created = await agent().resource(collectionName).create({ values });
        expect(created.status).toBe(200);
      }
      const initial = [
        { id: 1, name: 'First draft', stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Second draft', stage: 'draft', tenantId: 'B' },
        { id: 3, name: 'Third draft', stage: 'draft', tenantId: 'B' },
        { id: 4, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(initial);
      // Every target is the caller's own known, explicitly listable harmless fixture.
      // 所有目标均为当前身份自己新增、已明确获准列出的无害夹具。
      const visible = await agent()
        .resource(collectionName)
        .list({ fields: ['id', 'name', 'stage', 'tenantId'], sort: ['id'] });
      expect(visible.status).toBe(200);
      expect(visible.body.data).toEqual(initial);
      // The test resource helper also places filterByTk in a scalar REST path; send batch keys in the query.
      // 测试 resource 助手还会把 filterByTk 放入单条 REST 路径；批量主键仅经查询参数发送。
      const mutate = ({ filterByTk, filter, values }: Record<string, unknown>) => {
        const query = Array.isArray(filterByTk)
          ? filterByTk.map((key) => `filterByTk[]=${encodeURIComponent(String(key))}`).join('&')
          : `filter=${encodeURIComponent(JSON.stringify(filter))}`;
        return agent()
          .post(`/${collectionName}:${operation}?${query}`)
          .send(values ?? {});
      };
      const rejected = await mutate({
        filterByTk: [2, 4, 1, 2],
        ...(operation === 'update' ? { values: { name: 'Rejected batch' } } : {}),
      });
      expect(rejected.status).toBe(403);
      expect(rejected.body.errors[0].message).toMatch(/Record is unavailable for this mutation/);
      expect(await rows()).toEqual(initial);

      const selected = await mutate({
        filterByTk: [2, 1, 2],
        ...(operation === 'update' ? { values: { name: 'Selected draft' } } : {}),
      });
      expect(selected.status).toBe(200);
      expect(selected.body.data).toEqual({ keys: [1, 2], affected: 2 });
      expect(await rows()).toEqual(
        operation === 'update'
          ? [
              { id: 1, name: 'Selected draft', stage: 'draft', tenantId: 'B' },
              { id: 2, name: 'Selected draft', stage: 'draft', tenantId: 'B' },
              { id: 3, name: 'Third draft', stage: 'draft', tenantId: 'B' },
              { id: 4, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
            ]
          : [
              { id: 3, name: 'Third draft', stage: 'draft', tenantId: 'B' },
              { id: 4, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
            ],
      );
      // A broad filter selects within the role scope; it is not a promise to mutate every visible match.
      // 宽条件只在角色范围内选中目标，并不承诺修改全部可见匹配行。
      const matching = await mutate({
        filter: { stage: { $in: ['draft', 'submitted'] } },
        ...(operation === 'update' ? { values: { name: 'Filtered draft' } } : {}),
      });
      expect(matching.status).toBe(200);
      expect(matching.body.data).toEqual(
        operation === 'update' ? { keys: [1, 2, 3], affected: 3 } : { keys: [3], affected: 1 },
      );
      expect(await rows()).toEqual(
        operation === 'update'
          ? [
              { id: 1, name: 'Filtered draft', stage: 'draft', tenantId: 'B' },
              { id: 2, name: 'Filtered draft', stage: 'draft', tenantId: 'B' },
              { id: 3, name: 'Filtered draft', stage: 'draft', tenantId: 'B' },
              { id: 4, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
            ]
          : [{ id: 4, name: 'Submitted task', stage: 'submitted', tenantId: 'B' }],
      );
    },
  );
});
