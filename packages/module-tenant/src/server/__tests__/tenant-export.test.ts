import xlsx from 'node-xlsx';
import path from 'node:path';

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
    expect(decodeURIComponent(response.headers['content-disposition'])).toContain('tenant-export-posts_tenant-a.xlsx');

    const sheets = xlsx.parse(response.body);
    const rows = sheets[0]?.data || [];

    expect(rows).toContainEqual(['Title']);
    expect(rows).toContainEqual(['A1']);
    expect(rows).not.toContainEqual(['B1']);
  });

  it('should pass tenant context into worker export and include tenant marker in the generated file path', async () => {
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
        username: 'tenant_export_worker_user',
        email: 'tenant-export-worker-user@example.com',
        phone: '10000010012',
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
        name: 'tenant_export_worker_posts',
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

    const callPluginMethod = vi.fn(async ({ params }) => {
      expect(params.currentTenantId).toBe('tenant-a');
      expect(params.title).toBe('tenant-export-posts');
      return 'storage/uploads/tenants/tenant-a/tenant_export_worker_posts_tenant-a_202604181340.xlsx';
    });

    app.worker = {
      available: true,
      callPluginMethod,
    } as any;

    const response = await app.agent().login(user).resource('tenant_export_worker_posts').export({
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
    });

    expect(response.status).toBe(200);
    expect(callPluginMethod).toHaveBeenCalledTimes(1);
    expect(response.body.filename).toContain(path.posix.join('tenants', 'tenant-a'));
    expect(response.body.filename).toContain('tenant-a');
  });

  it('should keep original export title in download filename while appending tenant marker', async () => {
    app = await createTenantApp({
      extraPlugins: [[ExportPlugin, { name: 'action-export', packageName: '@tachybase/plugin-action-export' }]],
    });

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_export_filename_user',
        email: 'tenant-export-filename-user@example.com',
        phone: '10000010013',
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
          actions: ['create', 'view', 'update', 'destroy', 'export'],
        },
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_export_filename_posts',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });

    await app.db.getRepository('tenant_export_filename_posts').create({
      values: [{ title: 'A1', tenantId: 'tenant-a' }],
    });

    const response = await app.agent().login(user).resource('tenant_export_filename_posts').export({
      values: {
        title: '租户导出清单',
        columns: [
          {
            dataIndex: ['title'],
            defaultTitle: 'Title',
            title: 'Title',
          },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(decodeURIComponent(response.headers['content-disposition'])).toContain('租户导出清单_tenant-a.xlsx');
  });
});
