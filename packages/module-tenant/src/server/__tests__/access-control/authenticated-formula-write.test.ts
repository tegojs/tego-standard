import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import FormulaFieldPlugin from '../../../../../plugin-field-formula/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated calculated business amounts', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Skipping recalculation, imposing a post-write scope or ignoring the next request's persisted amount must fail.
  // 跳过重算、误加写后范围限制或忽略下一请求中的持久金额，都应导致失败。
  it('preserves formula recalculation and pre-write edit scopes across real authenticated requests', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [FormulaFieldPlugin],
    });
    for (const id of ['B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    const roleName = 'calculated-order-editor';
    await app.db.getRepository('roles').create({
      values: { name: roleName, strategy: { actions: [] }, snippets: [] },
    });
    const account = 'calculated-order-author';
    const password = 'calculated-order-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: [roleName], tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'calculatedBusinessOrders';
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
          { name: 'price', type: 'integer' },
          { name: 'quantity', type: 'integer' },
          { name: 'total', type: 'formula', expression: '{{price}}*{{quantity}}', engine: 'math.js' },
        ],
      },
    });
    const fields = ['id', 'name', 'price', 'quantity', 'total', 'tenantId'];
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        key: 'calculated-order-update-limit',
        dataSourceKey: 'main',
        resourceName: collectionName,
        scope: { total: { $lte: 100 } },
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name', 'price', 'quantity'] },
          { name: 'list', fields },
          { name: 'update', fields: ['quantity'], scope: { id: scope.get('id') } },
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
      { name: 'create', fields: ['name', 'price', 'quantity'], filter: null },
      { name: 'list', fields: ['id', 'name', 'price', 'quantity', 'tenantId', 'total'], filter: null },
      { name: 'update', fields: ['quantity'], filter: { total: { $lte: 100 } } },
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
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'context', path: 'role.name' },
                  right: { type: 'literal', value: roleName },
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
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (tenant = 'B') =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', roleName)
        .set('X-Tenant-Id', tenant);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(userId);
    const collection = app.db.getCollection(collectionName);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    for (const [index, tenantId] of ['B', 'C'].entries()) {
      const created = await agent(tenantId)
        .resource(collectionName)
        .create({ values: { name: `Order ${tenantId}`, price: 10, quantity: index + 2 } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [index + 1], affected: 1 });
    }
    const other = { id: 2, name: 'Order C', price: 10, quantity: 3, total: 30, tenantId: 'C' };
    const initial = { id: 1, name: 'Order B', price: 10, quantity: 2, total: 20, tenantId: 'B' };
    expect(await rows()).toEqual([initial, other]);
    const list = async (tenant: string, expected: typeof initial) => {
      const response = await agent(tenant)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([expected]);
    };
    await list('B', initial);
    await list('C', other);
    const update = (quantity: number, tenant = 'B', key = 1) =>
      agent(tenant).resource(collectionName).update({ filterByTk: key, values: { quantity } });
    const edited = await update(5);
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
    const within = { id: 1, name: 'Order B', price: 10, quantity: 5, total: 50, tenantId: 'B' };
    expect(await rows()).toEqual([within, other]);
    await list('B', within);
    const transitioned = await update(12);
    expect(transitioned.status).toBe(200);
    expect(transitioned.body.data).toEqual({ keys: [1], affected: 1 });
    const outside = { id: 1, name: 'Order B', price: 10, quantity: 12, total: 120, tenantId: 'B' };
    expect(await rows()).toEqual([outside, other]);
    await list('B', outside);
    const denied = await update(7);
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual([outside, other]);
    await list('B', outside);
    const resumed = await update(7, 'C', 2);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toEqual({ keys: [2], affected: 1 });
    const final = { id: 2, name: 'Order C', price: 10, quantity: 7, total: 70, tenantId: 'C' };
    expect(await rows()).toEqual([outside, final]);
    await list('B', outside);
    await list('C', final);
  });
});
