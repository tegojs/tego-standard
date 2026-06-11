import { ICollectionManager, IModel } from '@tachybase/data-source/src/types';
import { createMockServer, MockServer } from '@tachybase/test';
import { CollectionManager, DataSource, IRepository } from '@tego/server';

import { SuperAgentTest } from 'supertest';

async function waitFor<T>(callback: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  let lastValue: T;

  while (Date.now() - startedAt < timeoutMs) {
    const value = await callback();
    lastValue = value;
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  lastValue = await callback();
  if (predicate(lastValue)) {
    return lastValue;
  }

  let lastValueText: string;
  try {
    lastValueText = JSON.stringify(lastValue);
  } catch (error) {
    lastValueText = String(lastValue);
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms. Last value: ${lastValueText}`);
}

describe('data source with acl', () => {
  let app: MockServer;
  const dataSourceAclTestPlugins = [
    'acl',
    'error-handler',
    'users',
    'auth',
    'ui-schema-storage',
    'collection-manager',
    'data-source-manager',
  ];

  const getDataSourceAgent = (agent: SuperAgentTest, dataSourceKey: string) => {
    return agent.set('X-data-source', dataSourceKey) as any;
  };

  beforeAll(async () => {
    app = await createMockServer({
      plugins: dataSourceAclTestPlugins,
      acl: true,
    });

    class MockRepository implements IRepository {
      count(options?: any): Promise<number> {
        return Promise.resolve(0);
      }

      findAndCount(options?: any): Promise<[IModel[], number]> {
        return Promise.resolve([[], 0]);
      }

      async find() {
        return [];
      }

      async findOne() {
        return {};
      }

      async create() {}

      async update() {}

      async destroy() {}
    }

    class MockCollectionManager extends CollectionManager {
      getRepository(name: string, sourceId?: string | number): IRepository {
        return new MockRepository();
      }
    }

    class MockDataSource extends DataSource {
      async load(): Promise<void> {
        this.collectionManager.defineCollection({
          name: 'posts',
          fields: [
            {
              type: 'string',
              name: 'title',
            },
            {
              type: 'hasMany',
              name: 'comments',
            },
          ],
        });

        this.collectionManager.defineCollection({
          name: 'comments',
          fields: [
            {
              type: 'string',
              name: 'content',
            },
          ],
        });
      }

      createCollectionManager(options?: any): ICollectionManager {
        return new MockCollectionManager();
      }
    }

    app.dataSourceManager.factory.register('mock', MockDataSource);

    await app.db.getRepository('dataSources').create({
      values: {
        key: 'mockInstance1',
        type: 'mock',
        displayName: 'Mock',
        options: {},
      },
    });

    const dataSourceManagerPlugin = app.pm.get('data-source-manager') as any;
    await waitFor(
      () => dataSourceManagerPlugin.dataSourceStatus?.['mockInstance1'],
      (status) => status === 'loaded',
    );
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should allow root user', async () => {
    const adminUser = await app.db.getRepository('users').create({
      values: {
        roles: ['root'],
      },
    });

    const adminAgent: any = app.agent().login(adminUser).set('x-data-source', 'mockInstance1');
    const postRes = await adminAgent.resource('api/posts').list({});
    expect(postRes.status).toBe(200);
  });

  it('should update roles resources', async () => {
    const adminUser = await app.db.getRepository('users').create({
      values: {
        roles: ['root'],
      },
    });

    const adminAgent: any = app.agent().login(adminUser);

    await adminAgent.resource('dataSources.roles', 'mockInstance1').update({
      filterByTk: 'member',
      values: {
        resources: [
          {
            posts: {
              actions: {
                view: {
                  fields: ['title'],
                },
              },
            },
          },
        ],
      },
    });
  });

  it('should set main data source strategy', async () => {
    const roleName = 'mainStrategyRole';
    const adminUser = await app.db.getRepository('users').create({
      values: {
        roles: ['root'],
      },
    });

    await app.db.getRepository('roles').create({
      values: {
        name: roleName,
        title: '主数据源策略测试角色',
      },
    });

    const testUser = await app.db.getRepository('users').create({
      values: {
        roles: [roleName],
      },
    });

    await app.db.getCollection('collections').repository.create({
      values: {
        name: 'posts',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    const adminAgent: any = app.agent().login(adminUser);

    const testUserAgent: any = app.agent().login(testUser);

    const listRes = await testUserAgent.resource('posts').list({});
    expect(listRes.status).toBe(403);

    const updateRes = await adminAgent.resource('dataSources.roles', 'main').update({
      filterByTk: roleName,
      values: {
        strategy: {
          actions: ['view'],
        },
      },
    });

    expect(updateRes.status).toBe(200);

    // get strategy
    const getRes = await adminAgent.resource('dataSources.roles', 'main').get({
      filterByTk: roleName,
    });

    expect(getRes.status).toBe(200);

    const testRole = app.acl.getRole(roleName);
    const roleData = testRole.toJSON();

    expect(roleData.strategy).toMatchObject({
      actions: ['view'],
    });

    const listRes2 = await testUserAgent.resource('posts').list({});
    expect(listRes2.status).toBe(200);
  });

  it('should create strategy', async () => {
    const roleName = 'dataSourceStrategyRole';
    const adminUser = await app.db.getRepository('users').create({
      values: {
        roles: ['root'],
      },
    });

    await app.db.getRepository('roles').create({
      values: {
        name: roleName,
        title: '外部数据源策略测试角色',
      },
    });

    const testUser = await app.db.getRepository('users').create({
      values: {
        roles: [roleName],
      },
    });

    const adminAgent: any = app.agent().login(adminUser);

    // should get permission error
    const testUserAgent = getDataSourceAgent(app.agent().login(testUser), 'mockInstance1');

    // @ts-ignore
    const listRes = await testUserAgent.resource('api/posts').list({});
    expect(listRes.status).toBe(403);

    // // update connection roles strategy
    const updateRes = await adminAgent.resource('dataSources.roles', 'mockInstance1').update({
      filterByTk: roleName,
      values: {
        strategy: {
          actions: ['view'],
        },
      },
    });

    expect(updateRes.status).toBe(200);
    // get strategy
    const getRes = await adminAgent.resource('dataSources.roles', 'mockInstance1').get({
      filterByTk: roleName,
    });
    expect(getRes.status).toBe(200);

    const dataSource = app.dataSourceManager.dataSources.get('mockInstance1');
    const acl = dataSource.acl;
    const testRole = acl.getRole(roleName);
    expect(testRole).toBeDefined();

    const roleData = testRole.toJSON();

    expect(roleData.strategy).toMatchObject({
      actions: ['view'],
    });

    const listRes2 = await testUserAgent.resource('api/posts').list({});
    expect(listRes2.status).toBe(200);
  });

  it('should create resources', async () => {
    const roleName = 'dataSourceResourceRole';
    const adminUser = await app.db.getRepository('users').create({
      values: {
        roles: ['root'],
      },
    });

    await app.db.getRepository('roles').create({
      values: {
        name: roleName,
        title: '外部数据源资源测试角色',
      },
    });

    const testUser = await app.db.getRepository('users').create({
      values: {
        roles: [roleName],
      },
    });

    const adminAgent: any = app.agent().login(adminUser);

    // should get permission error
    const testUserAgent = getDataSourceAgent(app.agent().login(testUser), 'mockInstance1');

    const createResourceResp = await adminAgent.resource('dataSources.rolesResourcesScopes', 'mockInstance1').create({
      values: {
        name: 'posts title starts with test',
        resourceName: 'posts',
        scope: {
          title: {
            $startsWith: 'test',
          },
        },
      },
    });

    expect(createResourceResp.status).toBe(200);

    // list scopes
    const listScopesResp = await adminAgent.resource('dataSources.rolesResourcesScopes', 'mockInstance1').list({});

    expect(listScopesResp.status).toBe(200);

    const scope = listScopesResp.body.data.find((item) => item.name === 'posts title starts with test');

    // create user resource permission
    const createConnectionResourceResp = await adminAgent.resource('roles.dataSourceResources', roleName).create({
      values: {
        dataSourceKey: 'mockInstance1',
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['content', 'title'],
            scope: {
              id: scope.id,
            },
          },
        ],
        name: 'posts',
      },
    });

    expect(createConnectionResourceResp.status).toBe(200);

    const data = createConnectionResourceResp.body.data;

    // update scope to null
    const updateScopeResp = await adminAgent.resource('roles.dataSourceResources', roleName).update({
      filter: {
        dataSourceKey: 'mockInstance1',
        name: 'posts',
      },
      values: {
        actions: data.actions.map((action) => {
          return {
            ...action,
            scope: null,
            fields: ['content'],
          };
        }),
      },
    });

    expect(updateScopeResp.status).toBe(200);

    // get resourcers
    const getResourceResp = await adminAgent.resource('roles.dataSourceResources', roleName).get({
      filter: {
        dataSourceKey: 'mockInstance1',
        name: 'posts',
      },
      appends: ['actions.scope'],
    });

    expect(getResourceResp.status).toBe(200);
    expect(getResourceResp.body.data.actions[0].scope).toBeNull();

    // get collection list
    const collectionListRep = await adminAgent.resource('roles.dataSourcesCollections', roleName).list({
      filter: {
        dataSourceKey: 'mockInstance1',
      },
    });
    expect(collectionListRep.status).toBe(200);

    // call roles check
    // @ts-ignore
    const checkRep = await app.agent().login(testUser).resource('roles').check({});
    expect(checkRep.status).toBe(200);

    const checkData = checkRep.body;

    expect(checkData.meta.dataSources.mockInstance1).toBeDefined();
  });

  // This test mutates the shared application middleware stack, so keep it last.
  it('should call application middleware', async () => {
    const middlewareFn = vi.fn();
    app.use(async (ctx, next) => {
      middlewareFn();
      await next();
    });

    const adminUser = await app.db.getRepository('users').create({
      values: {
        roles: ['root'],
      },
    });

    const adminAgent: any = app.agent().login(adminUser).set('x-data-source', 'mockInstance1');
    const listRes = await adminAgent.resource('api/posts').list();
    expect(listRes.status).toBe(200);
    expect(middlewareFn).toBeCalledTimes(1);
  });
});
