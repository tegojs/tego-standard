import { createMockServer, MockServer } from '@tachybase/test';

import compose from 'koa-compose';
import { vi } from 'vitest';

import { applyTenantScope, cacheMiddleware, parseBuilder, parseFieldAndAssociations } from '../actions/query';

const formatter = await import('../actions/formatter');

describe('query', () => {
  describe('parseBuilder', () => {
    const sequelize = {
      fn: vi.fn().mockImplementation((fn: string, field: string) => [fn, field]),
      col: vi.fn().mockImplementation((field: string) => field),
    };
    let ctx: any;
    let app: MockServer;
    beforeAll(async () => {
      app = await createMockServer({
        plugins: ['data-source-manager'],
      });
      app.db.options.underscored = true;
      app.db.collection({
        name: 'orders',
        fields: [
          {
            name: 'id',
            type: 'bigInt',
          },
          {
            name: 'price',
            type: 'double',
          },
          {
            name: 'createdAt',
            type: 'date',
          },
          {
            type: 'belongsTo',
            name: 'user',
            target: 'users',
            targetKey: 'id',
            foreignKey: 'userId',
          },
        ],
      });
      app.db.collection({
        name: 'users',
        fields: [
          {
            name: 'id',
            type: 'bigInt',
          },
          {
            name: 'name',
            type: 'string',
          },
        ],
      });
      ctx = {
        app,
        db: {
          sequelize,
          getRepository: (name: string) => app.db.getRepository(name),
          getModel: (name: string) => app.db.getModel(name),
          getCollection: (name: string) => app.db.getCollection(name),
          options: {
            underscored: true,
          },
        },
      };
    });
    it('should parse field and associations', async () => {
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              collection: 'orders',
              measures: [
                {
                  field: ['price'],
                  aggregation: 'sum',
                  alias: 'price',
                },
              ],
              dimensions: [
                {
                  field: ['createdAt'],
                },
                {
                  field: ['user', 'name'],
                },
              ],
            },
          },
        },
      };
      await parseFieldAndAssociations(context, async () => {});
      expect(context.action.params.values).toMatchObject({
        measures: [
          {
            field: 'orders.price',
            aggregation: 'sum',
            alias: 'price',
            type: 'double',
          },
        ],
        dimensions: [
          {
            field: 'orders.created_at',
            alias: 'createdAt',
            type: 'date',
          },
          {
            field: 'user.name',
            alias: 'user.name',
          },
        ],
        include: [
          {
            association: 'user',
          },
        ],
      });
    });
    it('should parse measures', async () => {
      const measures1 = [
        {
          field: ['price'],
        },
      ];
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              collection: 'orders',
              measures: measures1,
            },
          },
        },
      };
      await compose([parseFieldAndAssociations, parseBuilder])(context, async () => {});
      expect(context.action.params.values.queryParams.attributes).toEqual([['orders.price', 'price']]);
      const measures2 = [
        {
          field: ['price'],
          aggregation: 'sum',
          alias: 'price-alias',
        },
      ];
      const context2 = {
        ...ctx,
        action: {
          params: {
            values: {
              collection: 'orders',
              measures: measures2,
            },
          },
        },
      };
      await compose([parseFieldAndAssociations, parseBuilder])(context2, async () => {});
      expect(context2.action.params.values.queryParams.attributes).toEqual([[['sum', 'orders.price'], 'price-alias']]);
    });
    it('should parse dimensions', async () => {
      vi.spyOn(formatter, 'formatter').mockReturnValue('formatted-field');
      const dimensions = [
        {
          field: ['createdAt'],
          format: 'YYYY-MM-DD',
          alias: 'Created at',
        },
      ];
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              collection: 'orders',
              dimensions,
            },
          },
        },
      };
      await compose([parseFieldAndAssociations, parseBuilder])(context, async () => {});
      expect(context.action.params.values.queryParams.attributes).toEqual([['formatted-field', 'Created at']]);
      expect(context.action.params.values.queryParams.group).toEqual([]);
      const measures = [
        {
          field: ['field'],
          aggregation: 'sum',
        },
      ];
      const context2 = {
        ...ctx,
        action: {
          params: {
            values: {
              collection: 'orders',
              measures,
              dimensions,
            },
          },
        },
      };
      await compose([parseFieldAndAssociations, parseBuilder])(context2, async () => {});
      expect(context2.action.params.values.queryParams.group).toEqual(['formatted-field']);
    });
    it('should parse filter', async () => {
      const filter = {
        createdAt: {
          $gt: '2020-01-01',
        },
      };
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              collection: 'orders',
              filter,
            },
          },
        },
      };
      await compose([parseFieldAndAssociations, parseBuilder])(context, async () => {});
      expect(context.action.params.values.queryParams.where.createdAt).toBeDefined();
    });
  });
  describe('cacheMiddleware', () => {
    const key = 'test-key';
    const value = 'test-val';
    const query = vi.fn().mockImplementation(async (ctx, next) => {
      ctx.body = value;
      await next();
    });
    class MockCache {
      map: Map<string, any> = new Map();
      get(key: string) {
        return this.map.get(key);
      }
      set(key: string, value: any) {
        this.map.set(key, value);
      }
    }
    let ctx: any;
    beforeEach(() => {
      const cache = new MockCache();
      ctx = {
        tego: {
          cacheManager: {
            getCache: () => cache,
          },
        },
      };
    });
    it('should use cache', async () => {
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
            },
          },
        },
      };
      const cache = context.tego.cacheManager.getCache();
      expect(cache.get(key)).toBeUndefined();
      await compose([cacheMiddleware, query])(context, async () => {});
      expect(query).toBeCalled();
      expect(context.body).toEqual(value);
      expect(cache.get(key)).toEqual(value);
      vi.clearAllMocks();
      await compose([cacheMiddleware, query])(context, async () => {});
      expect(context.body).toEqual(value);
      expect(query).not.toBeCalled();
    });
    it('should not use cache', async () => {
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              uid: key,
            },
          },
        },
      };
      const cache = context.tego.cacheManager.getCache();
      cache.set(key, value);
      expect(cache.get(key)).toBeDefined();
      await compose([cacheMiddleware, query])(context, async () => {});
      expect(query).toBeCalled();
      expect(context.body).toEqual(value);
    });
    it('should refresh', async () => {
      const context = {
        ...ctx,
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: true,
              uid: key,
            },
          },
        },
      };
      const cache = context.tego.cacheManager.getCache();
      expect(cache.get(key)).toBeUndefined();
      await compose([cacheMiddleware, query])(context, async () => {});
      expect(query).toBeCalled();
      expect(context.body).toEqual(value);
      expect(cache.get(key)).toEqual(value);
      await compose([cacheMiddleware, query])(context, async () => {});
      expect(query).toBeCalled();
      expect(context.body).toEqual(value);
    });

    it('should isolate cache by tenant', async () => {
      const tenantAContext = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-a',
        },
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
            },
          },
        },
      };
      const tenantBContext = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-b',
        },
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
            },
          },
        },
      };

      await compose([cacheMiddleware, query])(tenantAContext, async () => {});
      expect(query).toBeCalledTimes(1);

      vi.clearAllMocks();

      await compose([cacheMiddleware, query])(tenantBContext, async () => {});
      expect(query).toBeCalledTimes(1);
    });

    it('should isolate cache by query payload within the same tenant', async () => {
      const firstContext = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-a',
        },
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
              collection: 'orders',
              dataSource: 'main',
              filter: {
                status: 'draft',
              },
            },
          },
        },
        get: vi.fn().mockReturnValue('Asia/Singapore'),
      };
      const secondContext = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-a',
        },
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
              collection: 'orders',
              dataSource: 'main',
              filter: {
                status: 'published',
              },
            },
          },
        },
        get: vi.fn().mockReturnValue('Asia/Singapore'),
      };

      await compose([cacheMiddleware, query])(firstContext, async () => {});
      expect(query).toBeCalledTimes(1);

      vi.clearAllMocks();

      await compose([cacheMiddleware, query])(secondContext, async () => {});
      expect(query).toBeCalledTimes(1);
    });

    it('should isolate cache by current user when query uses runtime user variables', async () => {
      const firstContext = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-a',
          currentUser: {
            id: 1,
          },
        },
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
              collection: 'orders',
              filter: {
                createdById: '{{ $user.id }}',
              },
            },
          },
        },
      };
      const secondContext = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-a',
          currentUser: {
            id: 2,
          },
        },
        action: {
          params: {
            values: {
              cache: {
                enabled: true,
              },
              refresh: false,
              uid: key,
              collection: 'orders',
              filter: {
                createdById: '{{ $user.id }}',
              },
            },
          },
        },
      };

      await compose([cacheMiddleware, query])(firstContext, async () => {});
      expect(query).toBeCalledTimes(1);

      vi.clearAllMocks();

      await compose([cacheMiddleware, query])(secondContext, async () => {});
      expect(query).toBeCalledTimes(1);
    });
  });

  describe('applyTenantScope', () => {
    let ctx: any;
    let app: MockServer;

    beforeAll(async () => {
      app = await createMockServer({
        plugins: ['data-source-manager'],
      });
      app.db.collection({
        name: 'tenant_orders',
        tenancy: 'tenantScoped',
        fields: [
          {
            name: 'id',
            type: 'bigInt',
          },
          {
            name: 'tenantId',
            type: 'string',
          },
        ],
      });
      ctx = {
        app,
        db: app.db,
      };
    });

    it('should append current tenant filter for tenant scoped collections', async () => {
      const context = {
        ...ctx,
        state: {
          currentTenantId: 'tenant-a',
        },
        action: {
          params: {
            values: {
              collection: 'tenant_orders',
              filter: {
                status: 'published',
              },
            },
          },
        },
      };

      await applyTenantScope(context, async () => {});

      expect(context.action.params.values.filter).toEqual({
        $and: [{ status: 'published' }, { tenantId: 'tenant-a' }],
      });
    });

    it('should resolve tenant scoped collection from the configured data source', async () => {
      const dataSourceDb = {
        getCollection: vi.fn().mockReturnValue({
          options: {
            tenancy: 'tenantScoped',
          },
        }),
      };
      const context = {
        ...ctx,
        tego: {
          dataSourceManager: {
            dataSources: new Map([
              [
                'tenant-ds',
                {
                  collectionManager: {
                    db: dataSourceDb,
                  },
                },
              ],
            ]),
          },
        },
        db: {
          getCollection: vi.fn().mockReturnValue(undefined),
        },
        state: {
          currentTenantId: 'tenant-b',
        },
        action: {
          params: {
            values: {
              dataSource: 'tenant-ds',
              collection: 'tenant_orders',
              filter: {
                status: 'draft',
              },
            },
          },
        },
      };

      await applyTenantScope(context, async () => {});

      expect(dataSourceDb.getCollection).toBeCalledWith('tenant_orders');
      expect(context.action.params.values.filter).toEqual({
        $and: [{ status: 'draft' }, { tenantId: 'tenant-b' }],
      });
    });
  });
});
