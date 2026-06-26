import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MockServer } from '@tachybase/test';

import xlsx from 'node-xlsx';
import ImportPlugin from '../../../../plugin-action-import/src/server';

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
          ['Title', 'tenantId'],
          ['Imported A1', 'tenant-b'],
        ],
      },
    ]);

    const filePath = path.join(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'tenant-import-posts.xlsx');
    await writeFile(filePath, workbook);

    let response;
    try {
      response = await app
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
            {
              dataIndex: ['tenantId'],
              defaultTitle: 'tenantId',
            },
          ]),
        );
    } finally {
      await unlink(filePath).catch(() => undefined);
    }

    expect(response.status).toBe(200);

    const record = await app.db.getRepository('tenant_import_posts').findOne();
    expect(record.get('title')).toBe('Imported A1');
    expect(record.get('tenantId')).toBe('tenant-a');
  });

  it('should resolve imported relation values within the current tenant context', async () => {
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
        username: 'tenant_import_relation_user',
        email: 'tenant-import-relation-user@example.com',
        phone: '10000010013',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a', 'tenant-b'],
        defaultTenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_import_categories',
        tenancy: 'tenantScoped',
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_import_articles',
        tenancy: 'tenantScoped',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
          {
            type: 'belongsTo',
            name: 'category',
            target: 'tenant_import_categories',
          },
        ],
      },
      context: {},
    });

    const categoryA = await app.db.getRepository('tenant_import_categories').create({
      values: {
        name: 'Shared Category',
        tenantId: 'tenant-a',
      },
    });

    await app.db.getRepository('tenant_import_categories').create({
      values: {
        name: 'Shared Category',
        tenantId: 'tenant-b',
      },
    });

    const workbook = xlsx.build([
      {
        name: 'Sheet 1',
        data: [
          ['Title', 'Category'],
          ['Imported A1', 'Shared Category'],
        ],
      },
    ]);

    const filePath = path.join(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'tenant-import-relation.xlsx');
    await writeFile(filePath, workbook);

    let response;
    try {
      response = await app
        .agent()
        .login(user)
        .post('/tenant_import_articles:importXlsx')
        .attach('file', filePath)
        .field(
          'columns',
          JSON.stringify([
            {
              dataIndex: ['title'],
              defaultTitle: 'Title',
            },
            {
              dataIndex: ['category', 'name'],
              defaultTitle: 'Category',
            },
          ]),
        );
    } finally {
      await unlink(filePath).catch(() => undefined);
    }

    expect(response.status).toBe(200);

    const article = await app.db.getRepository('tenant_import_articles').findOne({ appends: ['category'] });
    expect(article.get('category')?.id).toBe(categoryA.get('id'));
  });
});
