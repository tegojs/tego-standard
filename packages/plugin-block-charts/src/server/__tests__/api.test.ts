import { createMockServer, MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import compose from 'koa-compose';

import { applyTenantScope, parseBuilder, parseFieldAndAssociations, queryData } from '../actions/query';

describe('api', () => {
  let app: MockServer;
  let db: Database;

  beforeAll(async () => {
    app = await createMockServer({
      acl: true,
      plugins: ['users', 'auth', 'data-visualization'],
    });
    db = app.db;

    db.collection({
      name: 'chart_test',
      fields: [
        {
          type: 'double',
          name: 'price',
        },
        {
          type: 'bigInt',
          name: 'count',
        },
        {
          type: 'string',
          name: 'title',
        },
        {
          type: 'date',
          name: 'createdAt',
        },
      ],
    });
    db.collection({
      name: 'tenant_chart_test',
      tenancy: 'tenantScoped',
      legacyDataTenantIds: ['tenant-a'],
      fields: [
        {
          type: 'double',
          name: 'amount',
        },
        {
          type: 'string',
          name: 'tenantId',
        },
      ],
    });
    await db.sync();
    const repo = db.getRepository('chart_test');
    await repo.create({
      values: [
        { price: 1, count: 1, title: 'title1', createdAt: '2023-02-02' },
        { price: 2, count: 2, title: 'title2', createdAt: '2023-01-01' },
      ],
    });
    await db.getRepository('tenant_chart_test').create({
      values: [
        { amount: 10, tenantId: null },
        { amount: 90, tenantId: 'tenant-b' },
      ],
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  test('query', async () => {
    const ctx = {
      app,
      db,
      tego: app,
      action: {
        params: {
          values: {
            collection: 'chart_test',
            measures: [
              {
                field: ['price'],
                alias: 'Price',
              },
              {
                field: ['count'],
                alias: 'Count',
              },
            ],
            dimensions: [
              {
                field: ['title'],
                alias: 'Title',
              },
            ],
          },
        },
      },
    } as any;
    await compose([parseFieldAndAssociations, parseBuilder, queryData])(ctx, async () => {});
    expect(ctx.action.params.values.data).toBeDefined();
  });

  test('query with sort', async () => {
    const ctx = {
      app,
      db,
      tego: app,
      get: (key: string) => (key === 'x-timezone' ? '+00:00' : undefined),
      action: {
        params: {
          values: {
            collection: 'chart_test',
            measures: [
              {
                field: ['price'],
                aggregation: 'sum',
                alias: 'Price',
              },
            ],
            dimensions: [
              {
                field: ['title'],
                alias: 'Title',
              },
              {
                field: ['createdAt'],
                format: 'YYYY-MM',
              },
            ],
            orders: [{ field: 'createdAt', order: 'asc' }],
          },
        },
      },
    } as any;
    await compose([parseFieldAndAssociations, parseBuilder, queryData])(ctx, async () => {});
    expect(ctx.action.params.values.data).toBeDefined();
    expect(ctx.action.params.values.data).toMatchObject([{ createdAt: '2023-01' }, { createdAt: '2023-02' }]);
  });

  test('aggregate query uses the target collection legacy visibility instead of stale request context', async () => {
    const ctx = {
      app,
      db,
      tego: app,
      state: {
        currentTenantId: 'tenant-a',
        currentLegacyDataTenantIds: [],
      },
      get: () => undefined,
      action: {
        params: {
          values: {
            collection: 'tenant_chart_test',
            measures: [
              {
                field: ['amount'],
                aggregation: 'sum',
                alias: 'Amount',
              },
            ],
            dimensions: [],
            orders: [],
            filter: {},
          },
        },
      },
    } as any;

    await compose([applyTenantScope, parseFieldAndAssociations, parseBuilder, queryData])(ctx, async () => {});

    expect(ctx.action.params.values.data).toMatchObject([{ Amount: 10 }]);
  });
});
