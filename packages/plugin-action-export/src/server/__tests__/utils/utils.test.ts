import { mockServer, MockServer } from '@tachybase/test';
import Database from '@tego/server';

import {
  buildExportDownloadName,
  buildWorkerExportFileName,
  buildWorkerExportRelativePath,
  buildWorkerExportSavePath,
  emitSecurityViolation,
} from '../../utils';

describe('utils', () => {
  let columns = null;
  let db: Database;
  let app: MockServer;

  beforeEach(async () => {
    app = mockServer();
    db = app.db;
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('first columns2Appends', async () => {
    columns = [
      { dataIndex: ['f_kp6gk63udss'], defaultTitle: '商品名称' },
      {
        dataIndex: ['f_brjkofr2mbt'],
        enum: [
          { value: 'lzjqrrw2vdl', label: '节' },
          { value: 'i0qarqlm87m', label: '胡' },
          { value: '1fpb8x0swq1', label: '一一' },
        ],
        defaultTitle: '工在在',
      },
      { dataIndex: ['f_qhvvfuignh2', 'createdBy', 'id'], defaultTitle: 'ID' },
      { dataIndex: ['f_wu28mus1c65', 'roles', 'title'], defaultTitle: '角色名称' },
    ];
  });

  it('second columns2Appends', async () => {
    columns = [
      { dataIndex: ['f_kp6gk63udss'], defaultTitle: '商品名称' },
      {
        dataIndex: ['f_brjkofr2mbt'],
        enum: [
          { value: 'lzjqrrw2vdl', label: '节' },
          { value: 'i0qarqlm87m', label: '胡' },
          { value: '1fpb8x0swq1', label: '一一' },
        ],
        defaultTitle: '工在在',
      },
      { dataIndex: ['f_qhvvfuignh2', 'createdBy', 'id'], defaultTitle: 'ID' },
      { dataIndex: ['f_qhvvfuignh2', 'createdBy', 'nickname'], defaultTitle: '角色名称' },
    ];
  });

  it('should preserve readable title in download filename while sanitizing invalid path characters', () => {
    expect(buildExportDownloadName('租户/导出:清单', 'tenant-a')).toBe('租户_导出_清单_tenant-a');
  });

  it('should build tenant-aware worker file naming and path', () => {
    const fileName = buildWorkerExportFileName('posts', '租户导出清单', 'tenant-a');

    expect(fileName).toContain('tenant-a');
    expect(fileName).toMatch(/\.xlsx$/);
    expect(buildWorkerExportRelativePath(fileName, 'tenant-a')).toContain('storage/uploads/tenants/tenant-a');
    expect(buildWorkerExportRelativePath(fileName, 'tenant-a', 'custom/exports')).toContain(
      'custom/exports/tenants/tenant-a',
    );
    expect(buildWorkerExportSavePath('D:/runtime/storage/uploads', 'tenant-a')).toContain('tenant-a');
  });

  it('should keep numeric zero tenant id in export names and worker paths', () => {
    expect(buildExportDownloadName('Report', 0 as any)).toBe('Report_0');
    const fileName = buildWorkerExportFileName('posts', 'Export', 0 as any);

    expect(fileName).toContain('_0_');
    expect(buildWorkerExportRelativePath(fileName, 0 as any)).toContain('storage/uploads/tenants/0');
    expect(buildWorkerExportSavePath('D:/runtime/storage/uploads', 0 as any)).toContain('0');
  });

  it('should generate unique worker export file names for repeated exports in the same minute', () => {
    const first = buildWorkerExportFileName('posts', '租户导出清单', 'tenant-a');
    const second = buildWorkerExportFileName('posts', '租户导出清单', 'tenant-a');

    expect(first).not.toBe(second);
    expect(first).toMatch(/export_tenant-a_\d{12}_[a-f0-9]{8}\.xlsx$/);
    expect(second).toMatch(/export_tenant-a_\d{12}_[a-f0-9]{8}\.xlsx$/);
  });

  it('should warn when application emitter back-reference is missing', () => {
    const emit = vi.fn();
    const warn = vi.fn();
    const ctx = {
      app: { emit },
      tego: { logger: { warn } },
      action: {
        resourceName: 'posts',
        actionName: 'export',
      },
    };

    emitSecurityViolation(ctx, {
      type: 'tenant_bulk_export_alert',
      tenantId: 'tenant-a',
    });

    expect(emit).toHaveBeenCalledWith(
      'tenant.securityViolation',
      expect.objectContaining({ type: 'tenant_bulk_export_alert' }),
    );
    expect(warn).toHaveBeenCalledWith(
      'Application emitter back-reference is missing; tenant security events may not reach audit listeners',
      expect.objectContaining({
        resourceName: 'posts',
        actionName: 'export',
      }),
    );
  });

  it('should not throw when tenant security event listeners fail', () => {
    const warn = vi.fn();
    const ctx = {
      app: {
        __application: {
          emit: vi.fn(() => {
            throw new Error('listener failed');
          }),
        },
      },
      tego: { logger: { warn } },
      action: {
        resourceName: 'posts',
        actionName: 'export',
      },
    };

    expect(() =>
      emitSecurityViolation(ctx, {
        type: 'tenant_bulk_export_alert',
        tenantId: 'tenant-a',
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Failed to emit tenant security event; export flow will continue',
      expect.objectContaining({
        resourceName: 'posts',
        actionName: 'export',
        eventType: 'tenant_bulk_export_alert',
      }),
    );
  });
});
