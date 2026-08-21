import type { MockServer } from '@tachybase/test';
import { CollectionManager, DataSource } from '@tego/server';

import { createTenantApp } from './utils';

describe('tenant resource guard', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('allows only unassigned reads before the first tenant is configured', async () => {
    app = await createTenantApp();

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_unconfigured_user',
        email: 'tenant-unconfigured-user@example.com',
        phone: '10000000024',
        password: '123456',
        roles: ['admin'],
      },
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_unconfigured_posts',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });
    const legacyRecord = await app.db.getRepository('tenant_unconfigured_posts').create({
      values: { title: 'Legacy' },
    });
    const agent = app.agent().login(user);

    const listResponse = await agent.resource('tenant_unconfigured_posts').list({ paginate: false });
    const createResponse = await agent.resource('tenant_unconfigured_posts').create({
      values: { title: 'Forbidden' },
    });
    const updateResponse = await agent.resource('tenant_unconfigured_posts').update({
      filterByTk: legacyRecord.get('id'),
      values: { title: 'Forbidden' },
    });
    const destroyResponse = await agent.resource('tenant_unconfigured_posts').destroy({
      filterByTk: legacyRecord.get('id'),
    });

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toHaveLength(1);
    expect(listResponse.body.data[0].tenantId).toBeNull();
    expect(createResponse.status).toBe(403);
    expect(updateResponse.status).toBe(403);
    expect(destroyResponse.status).toBe(403);
    expect(await app.db.getRepository('tenant_unconfigured_posts').count()).toBe(1);
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
      },
      context: {
        state: {
          currentTenant: { id: 'tenant-b' },
          currentTenantId: 'tenant-b',
        },
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
      filterByTk: created.get('id'),
      values: {
        title: 'A2',
        tenantId: 'tenant-b',
      },
    });

    const currentAfterUpdate = await app.db.getRepository('tenant_posts').findOne({
      filterByTk: created.get('id'),
    });
    expect(currentAfterUpdate.get('title')).toBe('A2');
    expect(currentAfterUpdate.get('tenantId')).toBe('tenant-a');

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

  it('should allow configured tenants to read legacy records without allowing writes', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_guard_legacy_user',
        email: 'tenant-guard-legacy-user@example.com',
        phone: '10000000014',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a', 'tenant-b'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_posts',
        tenancy: 'tenantScoped',
        legacyDataTenantIds: ['tenant-a'],
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    await app.db.getRepository('tenant_legacy_posts').create({
      values: { title: 'A1' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    const legacyRecord = await app.db.getRepository('tenant_legacy_posts').create({
      values: { title: 'Legacy' },
    });

    const tenantAAgent = app.agent().login(user);
    const listResponse = await tenantAAgent.resource('tenant_legacy_posts').list({});
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.map((item) => item.title).sort()).toEqual(['A1', 'Legacy']);

    const countResponse = await tenantAAgent.resource('tenant_legacy_posts').count({});
    expect(countResponse.status).toBe(200);
    expect(countResponse.body.data).toBe(2);

    const getResponse = await tenantAAgent.resource('tenant_legacy_posts').get({
      filterByTk: legacyRecord.get('id'),
    });
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.data.title).toBe('Legacy');

    await tenantAAgent.resource('tenant_legacy_posts').update({
      filterByTk: legacyRecord.get('id'),
      values: {
        title: 'should-not-update-legacy',
      },
    });
    const legacyAfterUpdate = await app.db.getRepository('tenant_legacy_posts').findOne({
      filterByTk: legacyRecord.get('id'),
    });
    expect(legacyAfterUpdate.get('title')).toBe('Legacy');

    await tenantAAgent.resource('tenant_legacy_posts').destroy({
      filterByTk: legacyRecord.get('id'),
    });
    const legacyAfterDestroy = await app.db.getRepository('tenant_legacy_posts').findOne({
      filterByTk: legacyRecord.get('id'),
    });
    expect(legacyAfterDestroy).toBeTruthy();

    await app
      .agent()
      .login(user)
      .resource('tenants')
      .switch({
        values: {
          tenantId: 'tenant-b',
        },
      });
    const tenantBListResponse = await app.agent().login(user).resource('tenant_legacy_posts').list({});
    expect(tenantBListResponse.status).toBe(200);
    expect(tenantBListResponse.body.data).toHaveLength(0);
  });

  it('should add tenantId field when creating tenant-enabled collections', async () => {
    app = await createTenantApp();

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_auto_fields',
        tenancy: 'tenantInherited',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    const field = await app.db.getRepository('fields').findOne({
      filter: {
        collectionName: 'tenant_auto_fields',
        name: 'tenantId',
      },
    });

    expect(field).toBeTruthy();
    expect(field.get('type')).toBe('context');
    expect(field.get('dataIndex')).toBe('state.currentTenant.id');
    expect(field.get('createOnly')).toBe(true);
    expect(app.db.getCollection('tenant_auto_fields').getField('tenantId')).toBeTruthy();

    await app.db.getRepository('tenant_auto_fields').create({
      values: {
        title: 'A1',
      },
      context: {
        state: {
          currentTenant: { id: 'tenant-a' },
          currentTenantId: 'tenant-a',
        },
      },
    });

    const created = await app.db.getRepository('tenant_auto_fields').findOne();
    expect(created.get('tenantId')).toBe('tenant-a');
  });

  it('should add tenantId field when updating a collection to tenant-enabled mode', async () => {
    app = await createTenantApp();

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_enabled_later',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    const [updated] = await app.db.getRepository('collections').update({
      filterByTk: 'tenant_enabled_later',
      values: {
        tenancy: 'tenantScoped',
      },
    });

    const field = await app.db.getRepository('fields').findOne({
      filter: {
        collectionName: 'tenant_enabled_later',
        name: 'tenantId',
      },
    });

    expect(updated.get('tenancy')).toBe('tenantScoped');
    expect(field).toBeTruthy();
    expect(app.db.getCollection('tenant_enabled_later').getField('tenantId')).toBeTruthy();
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
    const dataSource = new MockDataSource({ name: 'mockTenantDs' } as any);
    dataSource.acl.allow('*', '*');
    await app.dataSourceManager.add(dataSource);
    dataSource.collectionManager.getCollection('posts').options.tenancy = 'tenantScoped';
    app.dataSourceManager.factory.register('mock', MockDataSource as any);

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

    expect(dataSource.collectionManager.getCollection('posts').options.tenancy).toBe('tenantScoped');

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

  it('should not bypass main data source tenant guard with an unresolved data source key', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_guard_fake_ds_user',
        email: 'tenant-guard-fake-ds-user@example.com',
        phone: '10000000010',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_fake_ds_posts',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });

    await app.db.getRepository('tenant_fake_ds_posts').create({
      values: {
        title: 'A1',
      },
      context: {
        state: {
          currentTenant: { id: 'tenant-a' },
          currentTenantId: 'tenant-a',
        },
      },
    });
    await app.db.getRepository('tenant_fake_ds_posts').create({
      values: {
        title: 'B1',
      },
      context: {
        state: {
          currentTenant: { id: 'tenant-b' },
          currentTenantId: 'tenant-b',
        },
      },
    });

    const response = await app
      .agent()
      .login(user)
      .set('X-data-source', 'missing-ds')
      .resource('tenant_fake_ds_posts')
      .list({});

    expect(response.status).toBe(200);
    expect(response.body.data.map((item: any) => item.title)).toEqual(['A1']);
  });

  it('should reject forged / unsigned Bearer tokens for tenant-scoped resources', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const victim = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_guard_victim',
        email: 'tenant-guard-victim@example.com',
        phone: '10000000009',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_forged_token_posts',
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

    // Forge a JWT: valid-looking header+payload but signed with the wrong key
    const forgedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const forgedPayload = Buffer.from(JSON.stringify({ userId: victim.get('id') })).toString('base64url');
    const forgedToken = `${forgedHeader}.${forgedPayload}.forgesig`;

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${forgedToken}`)
      .set('X-Authenticator', 'basic')
      .resource('tenant_forged_token_posts')
      .list({});

    // Auth middleware must reject the forged token – never reach tenant guard
    expect(response.status).toBe(401);
  });

  it.each(['set', 'add', 'remove', 'toggle'])(
    'should reject %s association actions across tenants',
    async (actionName) => {
      app = await createTenantApp();

      await app.db.getRepository('tenants').create({
        values: [
          { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
          { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
        ],
      });

      const user = await app.db.getRepository('users').create({
        values: {
          username: `tenant_association_guard_${actionName}`,
          email: `tenant-association-guard-${actionName}@example.com`,
          phone: `1000000001${actionName.length}`,
          password: '123456',
          roles: ['root'],
          tenants: ['tenant-a'],
          defaultTenantId: 'tenant-a',
        },
      });

      await app.db.getRepository('collections').create({
        values: {
          name: 'tenant_assoc_tags',
          tenancy: 'tenantScoped',
          fields: [{ type: 'string', name: 'name' }],
        },
        context: {},
      });
      await app.db.getRepository('collections').create({
        values: {
          name: 'tenant_assoc_posts',
          tenancy: 'tenantScoped',
          fields: [
            { type: 'string', name: 'title' },
            { type: 'belongsToMany', name: 'tags', target: 'tenant_assoc_tags' },
          ],
        },
        context: {},
      });

      const postA = await app.db.getRepository('tenant_assoc_posts').create({
        values: { title: 'Post A' },
        context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
      });
      const postB = await app.db.getRepository('tenant_assoc_posts').create({
        values: { title: 'Post B' },
        context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
      });
      const tagA = await app.db.getRepository('tenant_assoc_tags').create({
        values: { name: 'Tag A' },
        context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
      });
      const tagB = await app.db.getRepository('tenant_assoc_tags').create({
        values: { name: 'Tag B' },
        context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
      });

      const agent = app.agent().login(user);
      if (actionName === 'remove') {
        await app.db.getRepository('tenant_assoc_posts.tags', postA.get('id')).add([tagA.get('id'), tagB.get('id')]);
      }

      const allowedResponse = await agent.resource('tenant_assoc_posts.tags', postA.get('id'))[actionName]({
        values: [tagA.get('id')],
      });
      expect(allowedResponse.status).toBe(200);

      const targetResponse = await agent.resource('tenant_assoc_posts.tags', postA.get('id'))[actionName]({
        values: [tagB.get('id')],
      });
      expect(targetResponse.status).toBeGreaterThanOrEqual(400);

      const sourceResponse = await agent.resource('tenant_assoc_posts.tags', postB.get('id'))[actionName]({
        values: [tagB.get('id')],
      });
      expect(sourceResponse.status).toBeGreaterThanOrEqual(400);
    },
  );

  it('should reject cross-tenant association values in root create and update actions', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_root_association_guard',
        email: 'tenant-root-association-guard@example.com',
        phone: '10000000019',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_root_assoc_tags',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'name' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_root_assoc_posts',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'belongsToMany', name: 'tags', target: 'tenant_root_assoc_tags' },
          { type: 'belongsTo', name: 'primaryTag', target: 'tenant_root_assoc_tags' },
        ],
      },
      context: {},
    });

    const postA = await app.db.getRepository('tenant_root_assoc_posts').create({
      values: { title: 'Post A' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    const tagA = await app.db.getRepository('tenant_root_assoc_tags').create({
      values: { name: 'Tag A' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    const tagB = await app.db.getRepository('tenant_root_assoc_tags').create({
      values: { name: 'Tag B' },
      context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
    });

    const agent = app.agent().login(user);
    const allowedCreate = await agent.resource('tenant_root_assoc_posts').create({
      values: {
        title: 'Allowed create',
        tags: [tagA.get('id')],
      },
    });
    expect(allowedCreate.status).toBe(200);

    const forbiddenCreate = await agent.resource('tenant_root_assoc_posts').create({
      values: {
        title: 'Forbidden create',
        tags: [{ id: tagB.get('id') }],
      },
    });

    const allowedUpdate = await agent.resource('tenant_root_assoc_posts').update({
      filterByTk: postA.get('id'),
      values: { tags: [tagA.get('id')] },
    });
    expect(allowedUpdate.status).toBe(200);

    const forbiddenUpdate = await agent.resource('tenant_root_assoc_posts').update({
      filterByTk: postA.get('id'),
      values: { tags: [tagB.get('id')] },
    });

    const primaryTagForeignKey = (app.db.getCollection('tenant_root_assoc_posts').model.associations.primaryTag as any)
      .foreignKey;
    const forbiddenForeignKeyUpdate = await agent.resource('tenant_root_assoc_posts').update({
      filterByTk: postA.get('id'),
      values: { [primaryTagForeignKey]: tagB.get('id') },
    });

    expect(forbiddenCreate.status).toBeGreaterThanOrEqual(400);
    expect(forbiddenUpdate.status).toBeGreaterThanOrEqual(400);
    expect(forbiddenForeignKeyUpdate.status).toBeGreaterThanOrEqual(400);

    const forbiddenPost = await app.db.getRepository('tenant_root_assoc_posts').findOne({
      filter: { title: 'Forbidden create' },
    });
    expect(forbiddenPost).toBeNull();

    const postResponse = await agent.resource('tenant_root_assoc_posts').get({
      filterByTk: postA.get('id'),
      appends: ['tags'],
    });
    expect(postResponse.status).toBe(200);
    expect(postResponse.body.data.tags).toHaveLength(1);
    expect(postResponse.body.data.tags[0].id).toBe(tagA.get('id'));
  });

  it('should not validate an unprovided belongs-to association that shares an explicit association foreign key', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_shared_foreign_key_guard',
        email: 'tenant-shared-foreign-key-guard@example.com',
        phone: '10000000028',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_shared_fk_legacy_products',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'name' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_shared_fk_new_products',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'name' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_shared_fk_items',
        tenancy: 'shared',
        fields: [
          { type: 'string', name: 'name' },
          {
            type: 'belongsTo',
            name: 'legacyProduct',
            target: 'tenant_shared_fk_legacy_products',
            foreignKey: 'productId',
          },
          {
            type: 'belongsTo',
            name: 'newProduct',
            target: 'tenant_shared_fk_new_products',
            foreignKey: 'productId',
          },
        ],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_shared_fk_orders',
        tenancy: 'shared',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'hasMany', name: 'items', target: 'tenant_shared_fk_items' },
        ],
      },
      context: {},
    });

    const legacyProduct = await app.db.getRepository('tenant_shared_fk_legacy_products').create({
      values: { name: 'Legacy product' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    const order = await app.db.getRepository('tenant_shared_fk_orders').create({
      values: { title: 'Order' },
    });
    const orderIdForeignKey = (app.db.getCollection('tenant_shared_fk_orders').model.associations.items as any)
      .foreignKey;
    const item = await app.db.getRepository('tenant_shared_fk_items').create({
      values: {
        name: 'Original item',
        productId: legacyProduct.get('id'),
        [orderIdForeignKey]: order.get('id'),
      },
    });

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_shared_fk_orders')
      .update({
        filterByTk: order.get('id'),
        updateAssociationValues: ['items'],
        values: {
          title: 'Updated order',
          items: [
            {
              id: item.get('id'),
              name: 'Updated item',
              productId: legacyProduct.get('id'),
              legacyProduct: { id: legacyProduct.get('id') },
            },
          ],
        },
      });

    expect(response.status).toBe(200);
    await item.reload();
    expect(item.get('name')).toBe('Updated item');
    expect(item.get('productId')).toBe(legacyProduct.get('id'));
  });

  it('should allow root creates to reference readable legacy belongs-to records', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_legacy_belongs_to_reference',
        email: 'tenant-legacy-belongs-to-reference@example.com',
        phone: '10000000025',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_reference_targets',
        tenancy: 'tenantInherited',
        legacyDataTenantIds: ['tenant-a'],
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_reference_posts',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'belongsTo', name: 'target', target: 'tenant_legacy_reference_targets' },
        ],
      },
      context: {},
    });

    const targetRepository = app.db.getRepository('tenant_legacy_reference_targets');
    const legacyTarget = await targetRepository.create({ values: { title: 'Legacy target' } });
    const tenantBTarget = await targetRepository.create({
      values: { title: 'Tenant B target' },
      context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
    });

    const agent = app.agent().login(user);
    const allowedResponse = await agent.resource('tenant_legacy_reference_posts').create({
      values: { title: 'References legacy target', target: { id: legacyTarget.get('id') } },
    });
    const forbiddenResponse = await agent.resource('tenant_legacy_reference_posts').create({
      values: { title: 'References tenant B target', target: { id: tenantBTarget.get('id') } },
    });

    expect(allowedResponse.status).toBe(200);
    expect(forbiddenResponse.status).toBeGreaterThanOrEqual(400);

    const foreignKey = (app.db.getCollection('tenant_legacy_reference_posts').model.associations.target as any)
      .foreignKey;
    const created = await app.db.getRepository('tenant_legacy_reference_posts').findOne({
      filter: { title: 'References legacy target' },
    });
    expect(created.get(foreignKey)).toBe(legacyTarget.get('id'));
  });

  it('should allow root creates to link readable legacy belongs-to-many records', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_legacy_belongs_to_many_reference',
        email: 'tenant-legacy-belongs-to-many-reference@example.com',
        phone: '10000000026',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_many_reference_targets',
        tenancy: 'tenantInherited',
        legacyDataTenantIds: ['tenant-a'],
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_many_reference_posts',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'belongsToMany', name: 'targets', target: 'tenant_legacy_many_reference_targets' },
        ],
      },
      context: {},
    });

    const target = await app.db.getRepository('tenant_legacy_many_reference_targets').create({
      values: { title: 'Legacy target' },
    });
    const response = await app
      .agent()
      .login(user)
      .resource('tenant_legacy_many_reference_posts')
      .create({
        values: { title: 'Links legacy target', targets: [{ id: target.get('id') }] },
      });

    expect(response.status).toBe(200);
  });

  it('should allow root updates to relink readable legacy associations without updating their values', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_legacy_update_reference',
        email: 'tenant-legacy-update-reference@example.com',
        phone: '10000000027',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_update_contacts',
        tenancy: 'tenantInherited',
        legacyDataTenantIds: ['tenant-a'],
        fields: [{ type: 'string', name: 'name' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_update_projects',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'name' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_legacy_update_companies',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'name' },
          { type: 'belongsToMany', name: 'contacts', target: 'tenant_legacy_update_contacts' },
          { type: 'belongsToMany', name: 'projects', target: 'tenant_legacy_update_projects' },
        ],
      },
      context: {},
    });

    const contact = await app.db.getRepository('tenant_legacy_update_contacts').create({
      values: { name: 'Legacy contact' },
    });
    const company = await app.db.getRepository('tenant_legacy_update_companies').create({
      values: { name: 'Company' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_legacy_update_companies')
      .update({
        filterByTk: company.get('id'),
        updateAssociationValues: ['projects'],
        values: {
          name: 'Updated company',
          contacts: [{ id: contact.get('id'), name: 'Must not update' }],
          projects: [],
        },
      });

    expect(response.status).toBe(200);

    const updatedCompany = await app.db.getRepository('tenant_legacy_update_companies').findOne({
      filterByTk: company.get('id'),
      appends: ['contacts'],
    });
    expect(updatedCompany.get('name')).toBe('Updated company');
    expect(updatedCompany.get('contacts')).toHaveLength(1);
    expect(updatedCompany.get('contacts')[0].get('id')).toBe(contact.get('id'));

    const forbiddenResponse = await app
      .agent()
      .login(user)
      .resource('tenant_legacy_update_companies')
      .update({
        filterByTk: company.get('id'),
        updateAssociationValues: ['contacts'],
        values: {
          contacts: [{ id: contact.get('id'), name: 'Must not update' }],
        },
      });
    expect(forbiddenResponse.status).toBeGreaterThanOrEqual(400);

    await contact.reload();
    expect(contact.get('name')).toBe('Legacy contact');
  });

  async function prepareMoveGuardUser() {
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    return app.db.getRepository('users').create({
      values: {
        username: 'tenant_move_guard_user',
        email: 'tenant-move-guard-user@example.com',
        phone: '10000000020',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
  }

  const tenantContext = (tenantId: string) => ({
    state: { currentTenant: { id: tenantId }, currentTenantId: tenantId },
  });

  async function prepareTenantMoveRecords(collectionName: string) {
    await app.db.getRepository('collections').create({
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'sort', name: 'sort' },
        ],
      },
      context: {},
    });

    const repository = app.db.getRepository(collectionName);
    const firstA = await repository.create({ values: { title: 'A1' }, context: tenantContext('tenant-a') });
    const middleB = await repository.create({ values: { title: 'B1' }, context: tenantContext('tenant-b') });
    const lastA = await repository.create({ values: { title: 'A2' }, context: tenantContext('tenant-a') });

    return { repository, firstA, middleB, lastA };
  }

  it.each([
    ['source', 'tenant-b', 'tenant-a'],
    ['target', 'tenant-a', 'tenant-b'],
  ])('should reject move when the %s record belongs to another tenant', async (_side, sourceTenant, targetTenant) => {
    app = await createTenantApp();
    const user = await prepareMoveGuardUser();
    const { firstA, middleB } = await prepareTenantMoveRecords('tenant_move_endpoint_items');
    const records = { 'tenant-a': firstA, 'tenant-b': middleB };

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_move_endpoint_items')
      .move({
        sourceId: records[sourceTenant].get('id'),
        targetId: records[targetTenant].get('id'),
      });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('should not renumber another tenant while moving records in the same collection', async () => {
    app = await createTenantApp();
    const user = await prepareMoveGuardUser();
    const { repository, firstA, middleB, lastA } = await prepareTenantMoveRecords('tenant_move_range_items');
    const middleSort = middleB.get('sort');

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_move_range_items')
      .move({
        sourceId: firstA.get('id'),
        targetId: lastA.get('id'),
      });

    expect(response.status).toBe(200);
    expect((await repository.findById(middleB.get('id'))).get('sort')).toBe(middleSort);
  });

  it('should not renumber another tenant while moving has-many association records', async () => {
    app = await createTenantApp();
    const user = await prepareMoveGuardUser();

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_move_assoc_items',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_move_assoc_lists',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          {
            type: 'hasMany',
            name: 'items',
            target: 'tenant_move_assoc_items',
            sortable: true,
          },
        ],
      },
      context: {},
    });

    const listA = await app.db.getRepository('tenant_move_assoc_lists').create({
      values: { title: 'List A' },
      context: tenantContext('tenant-a'),
    });
    const listCollection = app.db.getCollection('tenant_move_assoc_lists');
    const foreignKey = listCollection.model.associations.items.foreignKey;
    const sortField = `${foreignKey}Sort`;
    const itemRepository = app.db.getRepository('tenant_move_assoc_items');
    const firstA = await itemRepository.create({
      values: { title: 'A1', [foreignKey]: listA.get('id') },
      context: tenantContext('tenant-a'),
    });
    const middleB = await itemRepository.create({
      values: { title: 'B1', [foreignKey]: listA.get('id') },
      context: tenantContext('tenant-b'),
    });
    const lastA = await itemRepository.create({
      values: { title: 'A2', [foreignKey]: listA.get('id') },
      context: tenantContext('tenant-a'),
    });
    const middleSort = middleB.get(sortField);

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_move_assoc_lists.items', listA.get('id'))
      .move({
        sourceId: firstA.get('id'),
        targetId: lastA.get('id'),
      });

    expect(response.status).toBe(200);
    expect((await itemRepository.findById(middleB.get('id'))).get(sortField)).toBe(middleSort);
  });

  it('should reject moving a has-many record into a parent from another tenant', async () => {
    app = await createTenantApp();
    const user = await prepareMoveGuardUser();

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_move_scope_items',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_move_scope_lists',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          {
            type: 'hasMany',
            name: 'items',
            target: 'tenant_move_scope_items',
            sortable: true,
          },
        ],
      },
      context: {},
    });

    const listRepository = app.db.getRepository('tenant_move_scope_lists');
    const listA = await listRepository.create({
      values: { title: 'List A' },
      context: tenantContext('tenant-a'),
    });
    const listB = await listRepository.create({
      values: { title: 'List B' },
      context: tenantContext('tenant-b'),
    });
    const listCollection = app.db.getCollection('tenant_move_scope_lists');
    const foreignKey = listCollection.model.associations.items.foreignKey;
    const itemRepository = app.db.getRepository('tenant_move_scope_items');
    const itemA = await itemRepository.create({
      values: { title: 'Item A', [foreignKey]: listA.get('id') },
      context: tenantContext('tenant-a'),
    });

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_move_scope_lists.items', listA.get('id'))
      .move({
        sourceId: itemA.get('id'),
        targetScope: { [foreignKey]: listB.get('id') },
        method: 'prepend',
      });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await itemRepository.findById(itemA.get('id'))).get(foreignKey)).toBe(listA.get('id'));
  });
});
