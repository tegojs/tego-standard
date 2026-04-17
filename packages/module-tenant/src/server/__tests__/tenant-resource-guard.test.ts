import type { MockServer } from '@tachybase/test';

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
});
