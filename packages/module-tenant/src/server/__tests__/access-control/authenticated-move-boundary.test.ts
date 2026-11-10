import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business move boundary', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // A selected move must not fall back to a sorter that also writes the other rows in its interval.
  // 选中后的移动不得回退到会同时修改区间内其他记录的旧排序器。
  it('keeps legacy tenant sorting usable and selected moves inert while ordinary edits remain authorized', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    for (const id of ['B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    const roles = ['ordered-task-writer', 'ordered-task-reader'];
    for (const name of roles)
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const account = 'ordered-task-author';
    const password = 'ordered-task-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles, tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'orderedBusinessTasks';
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
          { name: 'sort', type: 'sort' },
        ],
      },
    });
    const fields = ['id', 'name', 'sort', 'tenantId'];
    for (const roleName of roles) {
      const expected =
        roleName === roles[0]
          ? [
              { name: 'create', fields: ['name'] },
              { name: 'list', fields },
              { name: 'update', fields: ['name'] },
            ]
          : [{ name: 'list', fields }];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: { dataSourceKey: 'main', roleName, name: collectionName, usingActionsConfig: true, actions: expected },
      });
      const actions = await resource.getActions({ include: ['scope'] });
      expect(
        actions
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
            scope: action.get('scope')?.get('scope') ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(
        expected
          .map((action) => ({ ...action, fields: [...action.fields].sort(), scope: null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
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
    const selectedKeys = new Set<string>();
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
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
    const initial = [
      { id: 1, name: 'First B', sort: 1, tenantId: 'B' },
      { id: 2, name: 'Other C', sort: 2, tenantId: 'C' },
      { id: 3, name: 'Last B', sort: 3, tenantId: 'B' },
    ];
    for (const row of initial) {
      const created = await agent(row.tenantId)
        .resource(collectionName)
        .create({ values: { name: row.name } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual(row);
    }
    expect(await rows()).toEqual(initial);
    const list = async (tenant: string, expected: typeof initial) => {
      const response = await agent(tenant)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expected);
    };
    await list('B', [initial[0], initial[2]]);
    await list('C', [initial[1]]);
    const deniedLegacy = await agent('B', roles[1])
      .resource(collectionName)
      .move({ sourceId: 1, targetId: 3, sortField: 'sort' });
    expect(deniedLegacy.status).toBe(403);
    expect(await rows()).toEqual(initial);
    const moved = await agent().resource(collectionName).move({ sourceId: 1, targetId: 3, sortField: 'sort' });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ data: 'ok' });
    const ordered = [
      { id: 1, name: 'First B', sort: 3, tenantId: 'B' },
      { id: 2, name: 'Other C', sort: 2, tenantId: 'C' },
      { id: 3, name: 'Last B', sort: 2, tenantId: 'B' },
    ];
    expect(await rows()).toEqual(ordered);
    selectedKeys.add(identity.collectionKey);
    await list('B', [ordered[0], ordered[2]]);
    const deniedSelected = await agent('B', roles[1])
      .resource(collectionName)
      .move({ sourceId: 3, targetId: 1, sortField: 'sort' });
    expect(deniedSelected.status).toBe(403);
    expect(await rows()).toEqual(ordered);
    const unsupported = await agent().resource(collectionName).move({ sourceId: 3, targetId: 1, sortField: 'sort' });
    expect(unsupported.status).toBe(400);
    expect(await rows()).toEqual(ordered);
    const edited = await agent()
      .resource(collectionName)
      .update({ filterByTk: 3, values: { name: 'Edited B' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [3], affected: 1 });
    const final = [ordered[0], ordered[1], { id: 3, name: 'Edited B', sort: 2, tenantId: 'B' }];
    expect(await rows()).toEqual(final);
    await list('B', [final[0], final[2]]);
    await list('C', [final[1]]);
  });
});
