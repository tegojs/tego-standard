import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated complete business lists', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // A default page loses option 21; a bypass exposes the other tenant, role-excluded row or private field.
  // 默认分页会遗漏第21项；绕过权限会暴露另一租户、角色范围外的行或未授权字段。
  it('serves normal unpaginated option requests under independent list ACL and tenant rules', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    for (const id of ['B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    const roles = ['complete-list-writer', 'complete-without-list'];
    for (const name of roles)
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const account = 'complete-list-author';
    const password = 'complete-list-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles, tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'completeBusinessOptions';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: ['name', 'stage', 'privateNote'].map((name) => ({ name, type: 'string' })),
      },
    });
    const fields = ['id', 'name', 'stage', 'tenantId'];
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        key: 'complete-draft-options',
        dataSourceKey: 'main',
        resourceName: collectionName,
        scope: { stage: { $eq: 'draft' } },
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: roles[0],
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name', 'stage', 'privateNote'] },
          { name: 'list', fields, scope: { id: scope.get('id') } },
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
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name', 'privateNote', 'stage'], filter: null },
      { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'], filter: { stage: { $eq: 'draft' } } },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
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
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (tenant = 'B', role = roles[0]) =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', tenant);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(userId);
    const collection = app.db.getCollection(collectionName);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const readable = Array.from({ length: 21 }, (_, index) => ({
      id: index + 1,
      name: `Option ${String(index + 1).padStart(2, '0')}`,
      stage: 'draft',
      tenantId: 'B',
    }));
    const full = [
      ...readable.map((row) => ({ ...row, privateNote: 'Private B note' })),
      { id: 22, name: 'Submitted option', stage: 'submitted', tenantId: 'B', privateNote: 'Private submitted note' },
      { id: 23, name: 'Other tenant option', stage: 'draft', tenantId: 'C', privateNote: 'Private C note' },
    ];
    for (const row of full) {
      const created = await agent(row.tenantId)
        .resource(collectionName)
        .create({
          values: { name: row.name, stage: row.stage, privateNote: row.privateNote },
        });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [row.id], affected: 1 });
    }
    expect(await rows()).toEqual(full);
    const paged = await agent()
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(paged.status).toBe(200);
    expect(paged.body).toEqual({
      data: readable.slice(0, 20),
      meta: { count: 21, page: 1, pageSize: 20, totalPage: 2 },
    });
    // AutoComplete sends this exact mode and empty filter; ReadPretty additionally selects known keys.
    // 自动补全发送该模式和空筛选；只读选择器还会按已知键筛选。
    const complete = await agent()
      .resource(collectionName)
      .list({ paginate: false, filter: {}, sort: ['id'] });
    expect(complete.status).toBe(200);
    expect(complete.body).toEqual({ data: readable });
    const selected = await agent()
      .resource(collectionName)
      .list({
        paginate: false,
        filter: { id: { $in: [21, 1] } },
        fields: ['id', 'name'],
        sort: ['id'],
      });
    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({
      data: [
        { id: 1, name: 'Option 01' },
        { id: 21, name: 'Option 21' },
      ],
    });
    const empty = await agent()
      .resource(collectionName)
      .list({ paginate: false, filter: { id: 0 } });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ data: [] });
    const denied = await agent('B', roles[1]).resource(collectionName).list({ paginate: false });
    expect(denied.status).toBe(403);
    expect(denied.body.data).toBeUndefined();
    expect(await rows()).toEqual(full);
  });
});
