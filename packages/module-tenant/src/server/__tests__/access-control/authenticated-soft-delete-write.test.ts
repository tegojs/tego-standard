import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated soft deletion', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Selected deletion must preserve paranoid storage and exclude the retained row from ordinary edits.
  // 选中表删除必须保留软删除存储语义，留存行不能重新成为普通编辑目标。
  it('retains soft-deleted physical rows without making them ordinary mutation targets', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'retained-task-editor';
    const password = 'retained-task-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const collectionName = 'retainedBusinessTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: true,
        paranoid: true,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    const model = app.db.getCollection(collectionName).model;
    expect(model.options.paranoid).toBe(true);
    const rows = () => model.findAll({ raw: true, paranoid: false, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
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
      { name: 'list', fields: ['id', 'name', 'tenantId'] },
      { name: 'update', fields: ['name'] },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
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
    expect(signedIn.body.data.user.id).toBe(user.get('id'));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(user.get('id'));
    for (const [id, name] of [
      [1, 'Retained draft'],
      [2, 'Active draft'],
    ] as const) {
      const created = await agent().resource(collectionName).create({ values: { name } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [id], affected: 1 });
    }
    const initial = await rows();
    expect(initial).toEqual([
      {
        id: 1,
        name: 'Retained draft',
        tenantId: 'B',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        deletedAt: null,
      },
      {
        id: 2,
        name: 'Active draft',
        tenantId: 'B',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        deletedAt: null,
      },
    ]);
    const list = () =>
      agent()
        .resource(collectionName)
        .list({ fields: ['id', 'name', 'tenantId'], sort: ['id'] });
    const visible = await list();
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([
      { id: 1, name: 'Retained draft', tenantId: 'B' },
      { id: 2, name: 'Active draft', tenantId: 'B' },
    ]);
    const destroyed = await agent().resource(collectionName).destroy({ filterByTk: 1 });
    expect(destroyed.status).toBe(200);
    expect(destroyed.body.data).toEqual({ keys: [1], affected: 1 });
    const retained = await rows();
    expect(retained).toEqual([{ ...initial[0], deletedAt: expect.any(String) }, initial[1]]);
    expect(Number.isFinite(Date.parse(retained[0].deletedAt))).toBe(true);
    const afterDelete = await list();
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.data).toEqual([{ id: 2, name: 'Active draft', tenantId: 'B' }]);
    // This is the same known harmless row just created and deleted by this caller.
    // 目标仅为当前身份刚刚创建并删除的同一条已知无害记录。
    const unavailable = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Must stay deleted' } });
    expect(unavailable.status).toBe(403);
    expect(await rows()).toEqual(retained);
    const updated = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Still active' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [2], affected: 1 });
    expect(await rows()).toEqual([retained[0], { ...initial[1], name: 'Still active', updatedAt: expect.any(String) }]);
    const final = await list();
    expect(final.status).toBe(200);
    expect(final.body.data).toEqual([{ id: 2, name: 'Still active', tenantId: 'B' }]);
  });
});
