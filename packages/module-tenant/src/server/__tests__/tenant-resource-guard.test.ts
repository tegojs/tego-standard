import type { MockServer } from '@tachybase/test';

import { waitSecond } from '@tachybase/test';
import { CollectionManager, DataSource } from '@tego/server';

import { createTenantApp } from './utils';

describe('tenant resource guard', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('should inject tenantId on create and restrict list/get/update/destroy to current tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_guard_user',
        email: 'tenant-guard-user@example.com',
        phone: '10000000004',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a', 'tenant-b'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('roles').update({
      filterByTk: 'admin',
      values: {
        strategy: {
          actions: ['create', 'view', 'update', 'destroy'],
        },
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_posts',
        tenancy: 'tenantScoped',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    const agent = app.agent().login(user);
    const createResponse = await agent.resource('tenant_posts').create({
      values: {
        title: 'A1',
        tenantId: 'tenant-b',
      },
    });

    expect(createResponse.status).toBe(200);

    const created = await app.db.getRepository('tenant_posts').findOne();
    expect(created.get('tenantId')).toBe('tenant-a');

    await app.db.getRepository('tenant_posts').create({
      values: {
        title: 'B1',
        tenantId: 'tenant-b',
      },
    });

    const listResponse = await agent.resource('tenant_posts').list({});
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toHaveLength(1);
    expect(listResponse.body.data[0].tenantId).toBe('tenant-a');

    const countResponse = await agent.resource('tenant_posts').count({});
    expect(countResponse.status).toBe(200);
    expect(countResponse.body.data).toBe(1);

    const foreignRecord = await app.db.getRepository('tenant_posts').findOne({
      filter: {
        tenantId: 'tenant-b',
      },
    });

    const getResponse = await agent.resource('tenant_posts').get({
      filterByTk: foreignRecord.get('id'),
    });
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.data).toBeNull();

    await agent.resource('tenant_posts').update({
      filterByTk: foreignRecord.get('id'),
      values: {
        title: 'should-not-update',
      },
    });

    const foreignAfterUpdate = await app.db.getRepository('tenant_posts').findOne({
      filterByTk: foreignRecord.get('id'),
    });
    expect(foreignAfterUpdate.get('title')).toBe('B1');

    await agent.resource('tenant_posts').destroy({
      filterByTk: foreignRecord.get('id'),
    });

    const foreignAfterDestroy = await app.db.getRepository('tenant_posts').findOne({
      filterByTk: foreignRecord.get('id'),
    });
    expect(foreignAfterDestroy).toBeTruthy();
  });

  it('should resolve tenant scoped collections from non-default data sources', async () => {
    let lastFilter: any;

    class MockRepository {
      async count() {
        return 1;
      }

      async findAndCount(options?: any) {
        lastFilter = options?.filter ?? options?.where;
        return [[{ id: 1, title: 'A1', tenantId: 'tenant-a' }], 1];
      }

      async find(options?: any) {
        lastFilter = options?.filter ?? options?.where;
        return [{ id: 1, title: 'A1', tenantId: 'tenant-a' }];
      }

      async findOne() {
        return null;
      }

      async create() {}

      async update() {}

      async destroy() {}
    }

    class MockCollectionManager extends CollectionManager {
      getRepository() {
        return new MockRepository() as any;
      }
    }

    class MockDataSource extends DataSource {
      async load(): Promise<void> {
        this.collectionManager.defineCollection({
          name: 'posts',
          tenancy: 'tenantScoped',
          fields: [
            {
              type: 'string',
              name: 'title',
            },
            {
              type: 'string',
              name: 'tenantId',
            },
          ],
        });
      }

      createCollectionManager() {
        return new MockCollectionManager();
      }
    }

    app = await createTenantApp();
    app.dataSourceManager.factory.register('mock', MockDataSource as any);

    await app.db.getRepository('dataSources').create({
      values: {
        key: 'mockTenantDs',
        type: 'mock',
        displayName: 'Mock tenant data source',
        options: {},
      },
    });

    await waitSecond(1000);

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_guard_ds_user',
        email: 'tenant-guard-ds-user@example.com',
        phone: '10000000005',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    const response = await app.agent().login(user).set('X-data-source', 'mockTenantDs').resource('api/posts').list({
      paginate: false,
    });

    expect(response.status).toBe(200);
    expect(lastFilter).toEqual({ tenantId: 'tenant-a' });
  });

  it('should reject tenant-scoped resources when the current user has no enabled tenant context', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-disabled', name: 'tenant-disabled', title: 'Tenant Disabled', enabled: false }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_guard_no_enabled_tenant',
        email: 'tenant-guard-no-enabled-tenant@example.com',
        phone: '10000000008',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-disabled'],
        defaultTenantId: 'tenant-disabled',
      },
    });

    await app.db.getRepository('roles').update({
      filterByTk: 'admin',
      values: {
        strategy: {
          actions: ['create', 'view', 'update', 'destroy'],
        },
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_posts_without_context',
        tenancy: 'tenantScoped',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    const response = await app.agent().login(user).resource('tenant_posts_without_context').list({});

    expect(response.status).toBe(403);
    expect(response.body.errors?.[0]?.message || response.body.error?.message).toContain('Tenant context is required');
  });
});
