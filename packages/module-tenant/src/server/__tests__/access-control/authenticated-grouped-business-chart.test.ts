import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import DataVisualizationPlugin from '../../../../../plugin-block-charts/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated grouped business charts', () => {
  // Catch pre-aggregation truncation, hidden rows changing group totals, or chart permission replacing field ACL.
  // 前N组须在完整授权汇总后截取，隐藏业务行和未授权字段不能借图表权限参与统计。
  it('orders complete authorized business groups before applying the chart display limit', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const analyst = 'grouped-business-analyst';
    const categoriesOnly = 'grouped-categories-only';
    const name = 'groupedBusinessSales';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [DataVisualizationPlugin],
      });
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      for (const role of [analyst, categoriesOnly])
        await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const password = 'grouped-business-password';
      const user = await app.db.getRepository('users').create({
        values: {
          username: analyst,
          password,
          roles: [analyst, categoriesOnly],
          tenants: ['B', 'C'],
          defaultTenantId: 'B',
        },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'category', type: 'string' },
            { name: 'amount', type: 'integer' },
            { name: 'stage', type: 'string' },
            { name: 'internalMemo', type: 'string' },
          ],
        },
      });
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
      const scopeFilter = { name: { $ne: 'ACL excluded' } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: name, name: 'Chartable sales', scope: scopeFilter },
      });
      for (const roleName of [analyst, categoriesOnly]) {
        const fields =
          roleName === analyst
            ? ['amount', 'category', 'id', 'name', 'stage', 'tenantId']
            : ['category', 'id', 'name', 'stage', 'tenantId'];
        const actions = [
          { name: 'list', fields, scope: { id: scope.get('id') } },
          ...(roleName === analyst
            ? [{ name: 'create', fields: ['amount', 'category', 'internalMemo', 'name', 'stage'] }]
            : []),
        ].sort((a, b) => a.name.localeCompare(b.name));
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: { dataSourceKey: 'main', roleName, name, usingActionsConfig: true, actions },
        });
        expect(
          (await resource.getActions({ include: ['scope'] }))
            .map((action) => ({
              name: action.get('name'),
              fields: [...action.get('fields')].sort(),
              scopeId: action.get('scope')?.get('id') ?? null,
              filter: action.get('scope')?.get('scope') ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(
          actions.map((action) => ({
            name: action.name,
            fields: action.fields,
            scopeId: action.name === 'list' ? scope.get('id') : null,
            filter: action.name === 'list' ? scopeFilter : null,
          })),
        );
      }
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: analyst, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (role = analyst, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const expectedRows = [
        {
          id: 1,
          name: 'First hardware sale',
          category: 'Hardware',
          amount: 40,
          stage: 'draft',
          internalMemo: 'memo1',
          tenantId: 'B',
        },
        {
          id: 2,
          name: 'Published hardware sale',
          category: 'Hardware',
          amount: 60,
          stage: 'published',
          internalMemo: 'memo2',
          tenantId: 'B',
        },
        {
          id: 3,
          name: 'Software sale',
          category: 'Software',
          amount: 70,
          stage: 'draft',
          internalMemo: 'memo3',
          tenantId: 'B',
        },
        {
          id: 4,
          name: 'ACL excluded',
          category: 'Software',
          amount: 9000,
          stage: 'draft',
          internalMemo: 'memo4',
          tenantId: 'B',
        },
        {
          id: 5,
          name: 'Archived sale',
          category: 'Hardware',
          amount: 8000,
          stage: 'archived',
          internalMemo: 'memo5',
          tenantId: 'B',
        },
        {
          id: 6,
          name: 'Other tenant sale',
          category: 'Hardware',
          amount: 12000,
          stage: 'draft',
          internalMemo: 'memo6',
          tenantId: 'C',
        },
      ];
      for (const row of expectedRows)
        expect(
          (
            await agent(analyst, row.tenantId)
              .resource(name)
              .create({
                values: {
                  name: row.name,
                  category: row.category,
                  amount: row.amount,
                  stage: row.stage,
                  internalMemo: row.internalMemo,
                },
              })
          ).status,
        ).toBe(200);
      expect(await rows()).toEqual(expectedRows);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      const stageCondition = (stage: string) => ({
        type: 'all' as const,
        children: [
          ownerCondition,
          {
            type: 'compare' as const,
            operator: 'eq' as const,
            left: { type: 'field' as const, path: 'stage' },
            right: { type: 'literal' as const, value: stage },
          },
        ],
      });
      const config = configFor(stageCondition('draft'));
      config.rules.push({
        ...configFor(stageCondition('published'), 'visibility').rules[0],
        id: 'published-sale-visible',
      });
      for (const rule of config.rules)
        rule.subject = {
          type: 'all',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'user.id' },
              right: { type: 'literal', value: String(user.id) },
            },
            {
              type: 'compare',
              operator: 'in',
              left: { type: 'context', path: 'role.name' },
              right: { type: 'literal', value: [analyst, categoriesOnly] },
            },
          ],
        };
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [identity.collectionKey]),
      );
      const listed = await agent()
        .resource(name)
        .list({ fields: ['id', 'amount', 'category'], sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([
        { id: 1, amount: 40, category: 'Hardware' },
        { id: 2, amount: 60, category: 'Hardware' },
        { id: 3, amount: 70, category: 'Software' },
      ]);
      const values = {
        uid: 'authorized-business-groups',
        dataSource: 'main',
        collection: name,
        measures: [
          { field: ['amount'], aggregation: 'sum', alias: 'total' },
          { field: ['id'], aggregation: 'count', alias: 'salesCount' },
        ],
        dimensions: [{ field: ['category'], alias: 'category' }],
        orders: [{ alias: 'total', order: 'desc' }],
        filter: {},
        limit: 1,
        cache: { enabled: true, ttl: 30 },
      };
      const top = await agent().resource('charts').query({ values });
      expect(top.status).toBe(200);
      expect(top.body).toEqual({ data: [{ category: 'Hardware', total: 100, salesCount: 2 }] });
      const complete = await agent()
        .resource('charts')
        .query({ values: { ...values, limit: 2 } });
      expect(complete.status).toBe(200);
      expect(complete.body).toEqual({
        data: [
          { category: 'Hardware', total: 100, salesCount: 2 },
          { category: 'Software', total: 70, salesCount: 1 },
        ],
      });
      const filtered = await agent()
        .resource('charts')
        .query({ values: { ...values, filter: { category: 'Software' } } });
      expect(filtered.status).toBe(200);
      expect(filtered.body).toEqual({ data: [{ category: 'Software', total: 70, salesCount: 1 }] });
      const forbiddenDimension = await agent()
        .resource('charts')
        .query({
          values: {
            ...values,
            dimensions: [{ field: ['internalMemo'], alias: 'memo' }],
          },
        });
      expect(forbiddenDimension.status).toBe(400);
      expect(forbiddenDimension.body.data).toBeUndefined();
      const limitedList = await agent(categoriesOnly)
        .resource(name)
        .list({ fields: ['id', 'category'], sort: ['id'] });
      expect(limitedList.status).toBe(200);
      expect(limitedList.body.data).toEqual([
        { id: 1, category: 'Hardware' },
        { id: 2, category: 'Hardware' },
        { id: 3, category: 'Software' },
      ]);
      const forbiddenMeasure = await agent(categoriesOnly).resource('charts').query({ values });
      expect(forbiddenMeasure.status).toBe(400);
      expect(forbiddenMeasure.body.data).toBeUndefined();
      expect(await rows()).toEqual(expectedRows);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
