import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import FullTextSearchPlugin from '../../../../../plugin-full-text-search/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business text search', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Ignoring the keyword, searching unreadable fields or bypassing role/tenant scopes must fail.
  // 忽略关键词、搜索未授权字段或绕过角色与租户范围，都应导致失败。
  it('serves the real fuzzy-search request under final list fields, role scope and tenant rules', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [FullTextSearchPlugin],
    });
    for (const id of ['B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    const roles = ['text-search-editor', 'text-search-without-list'];
    for (const name of roles)
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const account = 'text-search-author';
    const password = 'text-search-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles, tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'searchableBusinessTasks';
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
        key: 'searchable-drafts',
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
          { name: 'update', fields: ['name'] },
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
    ).toEqual([
      { name: 'create', fields: ['name', 'privateNote', 'stage'], filter: null },
      { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'], filter: { stage: { $eq: 'draft' } } },
      { name: 'update', fields: ['name'], filter: null },
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
    let selected = true;
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
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
    const model = app.db.getCollection(collectionName).model;
    const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const full = [
      { id: 1, name: 'Alpha task', stage: 'draft', privateNote: 'Private one', tenantId: 'B' },
      { id: 2, name: 'Beta task', stage: 'draft', privateNote: 'Alpha private note', tenantId: 'B' },
      { id: 3, name: 'Alpha submitted', stage: 'submitted', privateNote: 'Private three', tenantId: 'B' },
      { id: 4, name: 'Alpha other', stage: 'draft', privateNote: 'Private four', tenantId: 'C' },
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
    const baseline = await agent()
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(baseline.status).toBe(200);
    expect(baseline.body.data).toEqual([
      { id: 1, name: 'Alpha task', stage: 'draft', tenantId: 'B' },
      { id: 2, name: 'Beta task', stage: 'draft', tenantId: 'B' },
    ]);
    selected = false;
    const legacy = await agent()
      .resource(collectionName)
      .list({
        fields,
        search: { keywords: ['Alpha'], fields: ['name'] },
      });
    expect(legacy.status).toBe(200);
    expect(legacy.body.data).toEqual([{ id: 1, name: 'Alpha task', stage: 'draft', tenantId: 'B' }]);
    expect(await rows()).toEqual(full);
    selected = true;
    // FuzzySearchInput sends this keyword object alongside its existing block filter.
    // 原模糊搜索输入框发送该关键词对象，并保留区块筛选。
    const searched = await agent()
      .resource(collectionName)
      .list({
        fields,
        sort: ['id'],
        filter: {},
        search: { keywords: [' Alpha '] },
      });
    expect(searched.status).toBe(200);
    expect(searched.body).toEqual({
      data: [{ id: 1, name: 'Alpha task', stage: 'draft', tenantId: 'B' }],
      meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 },
    });
    expect(await rows()).toEqual(full);
    const disjunction = await agent()
      .resource(collectionName)
      .list({
        search: { keywords: ['Alpha', 'Beta'], fields: ['name'] },
        sort: ['id'],
      });
    expect(disjunction.status).toBe(200);
    expect(disjunction.body.data).toEqual(baseline.body.data);
    expect(disjunction.body.meta.count).toBe(2);
    const blank = await agent()
      .resource(collectionName)
      .list({ search: { keywords: [' '] }, sort: ['id'] });
    expect(blank.status).toBe(200);
    expect(blank.body.data).toEqual(baseline.body.data);
    const hidden = await agent()
      .resource(collectionName)
      .list({ search: { keywords: ['Alpha'], fields: ['privateNote'] } });
    expect(hidden.status).toBe(400);
    expect(hidden.body.data).toBeUndefined();
    expect(await rows()).toEqual(full);
    const denied = await agent('B', roles[1])
      .resource(collectionName)
      .list({ search: { keywords: ['Alpha'] } });
    expect(denied.status).toBe(403);
    expect(denied.body.data).toBeUndefined();
    expect(await rows()).toEqual(full);
    const edited = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Alpha second' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [2], affected: 1 });
    const changed = [full[0], { ...full[1], name: 'Alpha second' }, full[2], full[3]];
    expect(await rows()).toEqual(changed);
    const filtered = await agent()
      .resource(collectionName)
      .list({
        filter: { $and: [{ id: 2 }] },
        search: { keywords: ['Alpha'] },
        fields: ['id', 'name'],
      });
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toEqual([{ id: 2, name: 'Alpha second' }]);
    expect(filtered.body.meta.count).toBe(1);
    const complete = await agent()
      .resource(collectionName)
      .list({
        paginate: false,
        search: { keywords: ['Alpha'] },
        sort: ['id'],
      });
    expect(complete.status).toBe(200);
    expect(complete.body).toEqual({
      data: [
        { id: 1, name: 'Alpha task', stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Alpha second', stage: 'draft', tenantId: 'B' },
      ],
    });
    const unsupported = await agent()
      .resource(collectionName)
      .list({ search: { keywords: ['1'] } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.data).toBeUndefined();
    const other = await agent('C')
      .resource(collectionName)
      .list({ search: { keywords: ['Alpha'] } });
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual([{ id: 4, name: 'Alpha other', stage: 'draft', tenantId: 'C' }]);
    const empty = await agent()
      .resource(collectionName)
      .list({ search: { keywords: ['Unmatched'] } });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta.count).toBe(0);
    expect(await rows()).toEqual(changed);
  });
});
