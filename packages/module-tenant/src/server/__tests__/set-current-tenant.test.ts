import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('setCurrentTenant middleware', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('should resolve current tenant from the only bound tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: {
        id: 'tenant-a',
        name: 'tenant-a',
        title: 'Tenant A',
      },
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_a',
        email: 'user-a@example.com',
        phone: '10000000001',
        password: '123456',
        tenants: ['tenant-a'],
      },
    });

    const response = await app.agent().login(user).resource('tenants').current({});

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('tenant-a');
  });

  it('should allow switching to a valid requested tenant with X-Tenant header', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_b',
        email: 'user-b@example.com',
        phone: '10000000002',
        password: '123456',
        tenants: ['tenant-a', 'tenant-b'],
        defaultTenantId: 'tenant-a',
      },
    });

    const response = await app.agent().login(user).set('X-Tenant', 'tenant-b').resource('tenants').current({});

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('tenant-b');
  });

  it('should reject switching to an invalid tenant with X-Tenant header', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_c',
        email: 'user-c@example.com',
        phone: '10000000003',
        password: '123456',
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    const response = await app.agent().login(user).set('X-Tenant', 'tenant-b').resource('tenants').current({});

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('tenant-a');
  });

  it('should still reject invalid tenant header on tenant-scoped business resources', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_invalid_resource_tenant',
        email: 'user-invalid-resource-tenant@example.com',
        phone: '10000000007',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a'],
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
        name: 'tenant_guard_posts',
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

    const response = await app.agent().login(user).set('X-Tenant', 'tenant-b').resource('tenant_guard_posts').list({});

    expect(response.status).toBe(403);
  });

  it('should not resolve a disabled default tenant and should fallback to an enabled tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A', enabled: true },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B', enabled: false },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_disabled_default',
        email: 'user-disabled-default@example.com',
        phone: '10000000005',
        password: '123456',
        tenants: ['tenant-a', 'tenant-b'],
        defaultTenantId: 'tenant-b',
      },
    });

    const response = await app.agent().login(user).resource('tenants').current({});

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('tenant-a');
  });

  it('should reject switching to a disabled tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A', enabled: true },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B', enabled: false },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_disabled_switch',
        email: 'user-disabled-switch@example.com',
        phone: '10000000006',
        password: '123456',
        tenants: ['tenant-a', 'tenant-b'],
        defaultTenantId: 'tenant-a',
      },
    });

    const response = await app.agent().login(user).resource('tenants').switch({
      values: {
        tenantId: 'tenant-b',
      },
    });

    expect(response.status).toBe(403);
  });

  it('should list available tenants for current user and mark the active tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
        { id: 'tenant-c', name: 'tenant-c', title: 'Tenant C', enabled: false },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'user_d',
        email: 'user-d@example.com',
        phone: '10000000004',
        password: '123456',
        tenants: ['tenant-a', 'tenant-b', 'tenant-c'],
        defaultTenantId: 'tenant-b',
      },
    });

    const response = await app.agent().login(user).resource('tenants').available({});

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      {
        id: 'tenant-a',
        name: 'tenant-a',
        title: 'Tenant A',
        enabled: true,
        current: false,
      },
      {
        id: 'tenant-b',
        name: 'tenant-b',
        title: 'Tenant B',
        enabled: true,
        current: true,
      },
    ]);
  });
});
