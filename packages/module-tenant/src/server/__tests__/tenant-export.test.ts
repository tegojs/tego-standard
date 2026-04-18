import xlsx from 'node-xlsx';

import ExportPlugin from 'packages/plugin-action-export/src/server';

import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('tenant export', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('should export only current tenant records even when client passes a foreign tenant filter', async () => {
    app = await createTenantApp({
      extraPlugins: [[ExportPlugin, { name: 'action-export', packageName: '@tachybase/plugin-action-export' }]],
    });

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_export_user',
        email: 'tenant-export-user@example.com',
        phone: '10000010011',
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
          actions: ['create', 'view', 'update', 'destroy', 'export'],
        },
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_export_posts',
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

    await app.db.getRepository('tenant_export_posts').create({
      values: [
        { title: 'A1', tenantId: 'tenant-a' },
        { title: 'B1', tenantId: 'tenant-b' },
      ],
    });

    const response = await app.agent().login(user).resource('tenant_export_posts').export({
      values: {
        title: 'tenant-export-posts',
        columns: [
          {
            dataIndex: ['title'],
            defaultTitle: 'Title',
            title: 'Title',
          },
        ],
      },
      filter: {
        tenantId: 'tenant-b',
      },
    });

    expect(response.status).toBe(200);

    const sheets = xlsx.parse(response.body);
    const rows = sheets[0]?.data || [];

    expect(rows).toContainEqual(['Title']);
    expect(rows).toContainEqual(['A1']);
    expect(rows).not.toContainEqual(['B1']);
  });
});
