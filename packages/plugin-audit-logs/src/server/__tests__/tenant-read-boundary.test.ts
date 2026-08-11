import type { MockServer } from '@tachybase/test';

import { createTenantApp } from '../../../../module-tenant/src/server/__tests__/utils';

describe('audit log tenant read boundary', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createTenantApp({ extraPlugins: ['audit-logs'] });
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('restricts audit log and change reads to the current tenant', async () => {
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a' },
        { id: 'tenant-b', name: 'tenant-b' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'audit-reader',
        email: 'audit-reader@example.com',
        phone: '10000000001',
        password: '123456',
        roles: ['member'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    const auditLogRepo = app.db.getRepository('auditLogs');
    const currentTenantLog = await auditLogRepo.create({
      values: { type: 'create', collectionName: 'posts' },
      context: {
        state: {
          currentTenant: { id: 'tenant-a' },
          currentTenantId: 'tenant-a',
        },
      },
    });
    const foreignTenantLog = await auditLogRepo.create({
      values: { type: 'create', collectionName: 'posts' },
      context: {
        state: {
          currentTenant: { id: 'tenant-b' },
          currentTenantId: 'tenant-b',
        },
      },
    });
    const foreignChange = await app.db.getRepository('auditChanges').create({
      values: {
        auditLogId: foreignTenantLog.get('id'),
        field: { name: 'title' },
        before: 'before',
        after: 'after',
      },
    });

    const agent = app.agent().login(user).set('X-Tenant-Id', 'tenant-a');
    const listResponse = await agent.resource('auditLogs').list({ paginate: false });
    const currentLogResponse = await agent.resource('auditLogs').get({
      filterByTk: currentTenantLog.get('id'),
      appends: ['changes'],
    });
    const foreignLogResponse = await agent.resource('auditLogs').get({
      filterByTk: foreignTenantLog.get('id'),
    });
    const foreignChangeResponse = await agent.resource('auditChanges').get({
      filterByTk: foreignChange.get('id'),
    });

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toHaveLength(1);
    expect(listResponse.body.data[0].id).toBe(currentTenantLog.get('id'));
    expect(currentLogResponse.status).toBe(200);
    expect(currentLogResponse.body.data.id).toBe(currentTenantLog.get('id'));
    expect(foreignLogResponse.status).toBe(200);
    expect(foreignLogResponse.body.data).toBeNull();
    expect(foreignChangeResponse.status).toBe(403);
  });
});
