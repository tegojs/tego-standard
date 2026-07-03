import { createMockServer, type MockServer } from '@tachybase/test';
import { CollectionManager, DataSource } from '@tego/server';

import { createTenantApp } from './utils';

const TEST_ASSERTION_TIMEOUT = 10_000;

async function waitForDataSourceStatus(
  app: MockServer,
  key: string,
  expectedStatus: string,
  timeoutMs = TEST_ASSERTION_TIMEOUT,
) {
  const plugin = app.pm.get('data-source-manager') as any;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (plugin.dataSourceStatus?.[key] === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitForDataSourceStatus: "${key}" did not reach "${expectedStatus}" within ${timeoutMs}ms`);
}

async function waitForAuditLog(db: any, filter: Record<string, any>, timeoutMs = TEST_ASSERTION_TIMEOUT) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const log = await db.getRepository('auditLogs').findOne({ filter });
    if (log) {
      return log;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * Shared mock infrastructure: a DataSource whose repository captures the
 * last filter so we can assert tenant filter injection.
 */
function createMockDsClasses() {
  let lastFilter: any = null;
  let lastCreateValues: any = null;
  let lastUpdateFilter: any = null;
  let lastUpdateValues: any = null;

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

    async create(options?: any) {
      lastCreateValues = options?.values;
      return { id: 99 };
    }

    async update(options?: any) {
      lastUpdateFilter = options?.filter;
      lastUpdateValues = options?.values;
    }

    async destroy(options?: any) {
      lastUpdateFilter = options?.filter;
    }
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
          { type: 'string', name: 'title' },
          { type: 'string', name: 'tenantId' },
        ],
      });
    }

    createCollectionManager() {
      return new MockCollectionManager();
    }
  }

  return {
    MockDataSource,
    MockCollectionManager,
    get lastFilter() {
      return lastFilter;
    },
    get lastCreateValues() {
      return lastCreateValues;
    },
    get lastUpdateFilter() {
      return lastUpdateFilter;
    },
    get lastUpdateValues() {
      return lastUpdateValues;
    },
    resetCaptures() {
      lastFilter = null;
      lastCreateValues = null;
      lastUpdateFilter = null;
      lastUpdateValues = null;
    },
  };
}

async function setupTenantData(app: MockServer) {
  await app.db.getRepository('tenants').create({
    values: [
      { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
      { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
    ],
  });

  const user = await app.db.getRepository('users').create({
    values: {
      username: 'ext_ds_guard_user',
      email: 'ext-ds-guard-user@example.com',
      phone: '20000000001',
      password: '123456',
      roles: ['root'],
      tenants: ['tenant-a', 'tenant-b'],
      defaultTenantId: 'tenant-a',
    },
  });

  return user;
}

describe('tenant guard on external data sources', () => {
  let app: MockServer;
  const mocks = createMockDsClasses();

  afterEach(async () => {
    if (app) {
      await app.destroy();
    }
  });

  it('existing external data source: resource requests are filtered by current tenant (list, create, update, destroy)', async () => {
    app = await createTenantApp();
    app.dataSourceManager.factory.register('extGuard', mocks.MockDataSource);

    await app.db.getRepository('dataSources').create({
      values: {
        key: 'extGuardDs',
        displayName: 'Ext Guard DS',
        type: 'extGuard',
        options: {},
      },
    });
    await waitForDataSourceStatus(app, 'extGuardDs', 'loaded');

    const user = await setupTenantData(app);
    mocks.resetCaptures();

    // --- list: tenant-a filter injected ---
    const listRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'extGuardDs')
      .resource('api/posts')
      .list({ paginate: false });

    expect(listRes.status).toBe(200);
    expect(mocks.lastFilter).toEqual({ tenantId: 'tenant-a' });

    // --- create: tenantId forced to current tenant ---
    mocks.resetCaptures();
    const createRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'extGuardDs')
      .resource('api/posts')
      .create({ values: { title: 'New', tenantId: 'tenant-b' } });

    expect(createRes.status).toBe(200);
    expect(mocks.lastCreateValues.tenantId).toBe('tenant-a');
    expect(mocks.lastCreateValues.title).toBe('New');

    // --- update: filter scoped to tenant, tenantId stripped from values ---
    mocks.resetCaptures();
    const updateRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'extGuardDs')
      .resource('api/posts')
      .update({
        filterByTk: 1,
        values: { title: 'Updated', tenantId: 'tenant-b' },
      });

    expect([200, 204]).toContain(updateRes.status);
    // Tenant filter must be present in the update filter
    expect(mocks.lastUpdateFilter?.tenantId ?? mocks.lastUpdateFilter?.where?.tenantId).toBe('tenant-a');
    // tenantId must be stripped from update values (cannot escalate to another tenant)
    expect(mocks.lastUpdateValues.tenantId).toBeUndefined();
    expect(mocks.lastUpdateValues.title).toBe('Updated');

    // --- destroy: filter scoped to tenant ---
    mocks.resetCaptures();
    const destroyRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'extGuardDs')
      .resource('api/posts')
      .destroy({ filterByTk: 1 });

    expect([200, 204]).toContain(destroyRes.status);
    // Tenant filter must be present in the destroy filter
    expect(mocks.lastUpdateFilter?.tenantId ?? mocks.lastUpdateFilter?.where?.tenantId).toBe('tenant-a');
  });

  it('newly created external data source: resource requests are filtered by current tenant', async () => {
    app = await createTenantApp();
    app.dataSourceManager.factory.register('newDsType', mocks.MockDataSource);

    const user = await setupTenantData(app);

    // Create data source *after* tenant setup — simulates "add new data source at runtime"
    await app.db.getRepository('dataSources').create({
      values: {
        key: 'newDsInstance',
        displayName: 'New DS',
        type: 'newDsType',
        options: {},
      },
    });
    await waitForDataSourceStatus(app, 'newDsInstance', 'loaded');

    mocks.resetCaptures();

    const listRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'newDsInstance')
      .resource('api/posts')
      .list({ paginate: false });

    expect(listRes.status).toBe(200);
    expect(mocks.lastFilter).toEqual({ tenantId: 'tenant-a' });

    // Switch tenant and verify filter changes
    mocks.resetCaptures();
    await app
      .agent()
      .login(user)
      .resource('tenants')
      .switch({ values: { tenantId: 'tenant-b' } });

    const listRes2 = await app
      .agent()
      .login(user)
      .set('X-data-source', 'newDsInstance')
      .resource('api/posts')
      .list({ paginate: false });

    expect(listRes2.status).toBe(200);
    expect(mocks.lastFilter).toEqual({ tenantId: 'tenant-b' });
  });

  it('reloaded external data source: resource requests are still filtered by current tenant', async () => {
    app = await createTenantApp();
    app.dataSourceManager.factory.register('reloadDsType', mocks.MockDataSource);

    await app.db.getRepository('dataSources').create({
      values: {
        key: 'reloadDs',
        displayName: 'Reload DS',
        type: 'reloadDsType',
        options: {},
      },
    });
    await waitForDataSourceStatus(app, 'reloadDs', 'loaded');

    const user = await setupTenantData(app);

    // Verify filter before reload
    mocks.resetCaptures();
    const listRes1 = await app
      .agent()
      .login(user)
      .set('X-data-source', 'reloadDs')
      .resource('api/posts')
      .list({ paginate: false });

    expect(listRes1.status).toBe(200);
    expect(mocks.lastFilter).toEqual({ tenantId: 'tenant-a' });

    // Trigger reload by updating options (dataSources.afterSave → loadIntoApplication)
    mocks.resetCaptures();
    await app.db.getRepository('dataSources').update({
      filterByTk: 'reloadDs',
      values: { options: { reloaded: true } },
    });

    // Wait for reload to complete
    await waitForDataSourceStatus(app, 'reloadDs', 'loaded');

    // Verify filter still works after reload
    mocks.resetCaptures();
    const listRes2 = await app
      .agent()
      .login(user)
      .set('X-data-source', 'reloadDs')
      .resource('api/posts')
      .list({ paginate: false });

    expect(listRes2.status).toBe(200);
    expect(mocks.lastFilter).toEqual({ tenantId: 'tenant-a' });

    // Verify create also works after reload
    mocks.resetCaptures();
    const createRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'reloadDs')
      .resource('api/posts')
      .create({ values: { title: 'AfterReload' } });

    expect(createRes.status).toBe(200);
    expect(mocks.lastCreateValues.tenantId).toBe('tenant-a');
  });

  it('middleware chain: auth and setCurrentTenant run for external data source requests', async () => {
    app = await createTenantApp();
    app.dataSourceManager.factory.register('chainDsType', mocks.MockDataSource);

    await app.db.getRepository('dataSources').create({
      values: {
        key: 'chainDs',
        displayName: 'Chain DS',
        type: 'chainDsType',
        options: {},
      },
    });
    await waitForDataSourceStatus(app, 'chainDs', 'loaded');

    const user = await setupTenantData(app);

    // Intercept authManager.middleware to verify it is called in the chain
    const authMiddlewareSpy = vi.spyOn(app.authManager, 'middleware');

    mocks.resetCapturedFilter?.();
    mocks.resetCaptures();

    const response = await app
      .agent()
      .login(user)
      .set('X-data-source', 'chainDs')
      .resource('api/posts')
      .list({ paginate: false });

    expect(response.status).toBe(200);

    // Verify auth middleware was invoked (dataSourceManager.use calls authManager.middleware())
    expect(authMiddlewareSpy).toHaveBeenCalled();

    // Verify tenant filter was applied — proves setCurrentTenant + tenantResourceGuard ran
    expect(mocks.lastFilter).toEqual({ tenantId: 'tenant-a' });

    authMiddlewareSpy.mockRestore();
  });

  it('tenant module not enabled: external data source requests are not filtered by tenant', async () => {
    // Create app WITHOUT the tenant plugin
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      plugins: [
        'acl',
        'error-handler',
        'users',
        'ui-schema-storage',
        'collection-manager',
        'auth',
        'data-source-manager',
      ],
    });

    app.dataSourceManager.factory.register('noTenantDsType', mocks.MockDataSource);

    await app.db.getRepository('dataSources').create({
      values: {
        key: 'noTenantDs',
        displayName: 'No Tenant DS',
        type: 'noTenantDsType',
        options: {},
      },
    });
    await waitForDataSourceStatus(app, 'noTenantDs', 'loaded');

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'no_tenant_user',
        email: 'no-tenant-user@example.com',
        phone: '20000000002',
        password: '123456',
        roles: ['root'],
      },
    });

    mocks.resetCaptures();

    const listRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'noTenantDs')
      .resource('api/posts')
      .list({ paginate: false });

    expect(listRes.status).toBe(200);

    // Filter should NOT contain tenantId — no tenant module means no tenant filtering
    expect(mocks.lastFilter?.tenantId).toBeUndefined();

    // Create should NOT inject tenantId
    mocks.resetCaptures();
    const createRes = await app
      .agent()
      .login(user)
      .set('X-data-source', 'noTenantDs')
      .resource('api/posts')
      .create({ values: { title: 'NoTenant' } });

    expect(createRes.status).toBe(200);
    expect(mocks.lastCreateValues?.tenantId).toBeUndefined();
  });

  it('invalid external data source key cleanup emits a tenant security event', async () => {
    app = await createTenantApp({ extraPlugins: ['audit-logs'] });
    const user = await setupTenantData(app);

    const response = await app.agent().login(user).set('X-data-source', 'forgedDs').resource('tenants').available({});

    expect(response.status).toBe(200);

    const auditLog = await waitForAuditLog(app.db, {
      type: 'tenant_invalid_data_source_attempt',
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog.get('userId')).toBe(user.get('id'));
    expect(auditLog.get('details')).toMatchObject({
      dataSourceKey: 'forgedDs',
      headerDataSource: 'forgedDs',
    });
  });
});
