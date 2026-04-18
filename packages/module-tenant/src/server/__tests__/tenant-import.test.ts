import path from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';

import xlsx from 'node-xlsx';
import ImportPlugin from 'packages/plugin-action-import/src/server';

import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('tenant import', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('should ignore imported tenantId values and persist the current tenant instead', async () => {
    app = await createTenantApp({
      extraPlugins: [[ImportPlugin, { name: 'action-import', packageName: '@tachybase/plugin-action-import' }]],
    });

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
      ],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_import_user',
        email: 'tenant-import-user@example.com',
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
          actions: ['create', 'view', 'update', 'destroy', 'importXlsx'],
        },
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_import_posts',
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

    const workbook = xlsx.build([
      {
        name: 'Sheet 1',
        data: [
          ['Title'],
          ['Imported A1'],
        ],
      },
    ]);

    const filePath = path.join(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'tenant-import-posts.xlsx');
    await writeFile(filePath, workbook);

    const response = await app
      .agent()
      .login(user)
      .post('/tenant_import_posts:importXlsx')
      .attach('file', filePath)
      .field(
        'columns',
        JSON.stringify([
          {
            dataIndex: ['title'],
            defaultTitle: 'Title',
          },
        ]),
      )
      .finally(async () => {
        await unlink(filePath).catch(() => undefined);
      });

    expect(response.status).toBe(200);
    expect(response.body.successCount).toBe(1);

    const record = await app.db.getRepository('tenant_import_posts').findOne();
    expect(record.get('title')).toBe('Imported A1');
    expect(record.get('tenantId')).toBe('tenant-a');
  });
});
