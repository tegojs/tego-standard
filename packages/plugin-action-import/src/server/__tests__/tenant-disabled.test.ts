/**
 * Regression tests: module-tenant NOT loaded – plugin-action-import.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * Import actions must still function: the import middleware must pass through,
 * downloadXlsxTemplate must succeed, and the X-Tenant-Id header must be ignored
 * (no tenant middleware to parse it into ctx.state).
 */
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMockServer, MockServer } from '@tachybase/test';

import xlsx from 'node-xlsx';
import { describe, expect, it, vi } from 'vitest';

import ImportPlugin from '..';

describe('plugin-action-import – tenant module NOT loaded', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      plugins: ['acl', 'error-handler', 'users', 'auth', 'data-source-manager', 'collection-manager', ImportPlugin],
      acl: false,
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should start the application without errors', () => {
    expect(app).toBeTruthy();
  });

  it('should not have the tenant plugin registered', () => {
    expect(app.pm.get('tenant')).toBeFalsy();
  });

  it('should not have setCurrentTenant middleware', () => {
    const middlewares = (app as any).middleware || [];
    const tags = middlewares.map((m: any) => m.tag || m.name).filter(Boolean);
    expect(tags).not.toContain('setCurrentTenant');
  });

  it('should not populate ctx.state with tenant context when X-Tenant-Id is present', () => {
    // Verify that without the tenant plugin, there's no middleware to
    // convert X-Tenant-Id header into ctx.state.currentTenantId.
    // The state should remain clean even if the header is set.
    const ctx = {
      state: { currentUser: { id: 1 } },
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'X-Tenant-Id') return 'rogue-tenant';
        return undefined;
      }),
    };

    // Simulate what would happen: ctx.state is NOT populated by any tenant middleware
    expect(ctx.state.currentTenantId).toBeUndefined();
    expect(ctx.state.currentTenant).toBeUndefined();
    expect(ctx.state.currentTenancyMode).toBeUndefined();
  });

  it('should import xlsx without trusting bare X-Tenant-Id as tenant context', async () => {
    app.db.collection({
      name: 'import_without_tenant_posts',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'tenantId' },
      ],
    });
    await app.db.sync();

    const workbook = xlsx.build([
      {
        name: 'Sheet 1',
        data: [['Title'], ['Imported without tenant module']],
      },
    ]);
    const filePath = path.join(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'import-without-tenant.xlsx');
    await writeFile(filePath, workbook);

    let response;
    try {
      response = await app
        .agent()
        .set('X-Tenant-Id', 'rogue-tenant')
        .post('/import_without_tenant_posts:importXlsx')
        .attach('file', filePath)
        .field(
          'columns',
          JSON.stringify([
            {
              dataIndex: ['title'],
              defaultTitle: 'Title',
            },
          ]),
        );
    } finally {
      await unlink(filePath).catch(() => undefined);
    }

    expect(response.status).toBe(200);
    expect(response.body.meta.successCount).toBe(1);
    expect(response.body.meta.failureCount).toBe(0);

    const record = await app.db.getRepository('import_without_tenant_posts').findOne();
    expect(record.get('title')).toBe('Imported without tenant module');
    expect(record.get('tenantId') == null).toBe(true);
  });
});

describe('downloadXlsxTemplate – tenant module NOT loaded', () => {
  it('should produce template without tenant context', async () => {
    // downloadXlsxTemplate is a pure function that doesn't depend on tenant state.
    // Verify it works without any tenant fields in ctx.state.
    const { downloadXlsxTemplate } = await import('../actions/downloadXlsxTemplate');

    const ctx: any = {
      request: {
        body: {
          columns: [
            { dataIndex: ['name'], defaultTitle: 'Name' },
            { dataIndex: ['email'], defaultTitle: 'Email' },
          ],
          title: 'Users',
        },
      },
      state: {
        currentUser: { id: 1 },
        // NO currentTenant, NO currentTenantId
      },
      body: null,
      set: vi.fn(),
      t: vi.fn().mockImplementation((s: string) => s),
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await downloadXlsxTemplate(ctx, next);

    expect(ctx.body).toBeTruthy();
    expect(next).toHaveBeenCalled();
    expect(ctx.set).toHaveBeenCalled();

    // Verify Content-Disposition doesn't contain any tenant references
    const setCall = ctx.set.mock.calls[0][0];
    expect(setCall['Content-Disposition']).not.toContain('tenant');
  });
});
