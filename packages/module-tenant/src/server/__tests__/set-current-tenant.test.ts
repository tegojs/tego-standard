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

    expect(response.status).toBe(403);
  });
});
