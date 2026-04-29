import { mockServer, MockServer } from '@tachybase/test';

import Database from '@tego/server';

import {
  buildExportDownloadName,
  buildWorkerExportFileName,
  buildWorkerExportRelativePath,
  buildWorkerExportSavePath,
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
    expect(fileName).toEndWith('.xlsx');
    expect(buildWorkerExportRelativePath(fileName, 'tenant-a')).toContain('storage/uploads/tenants/tenant-a');
    expect(buildWorkerExportRelativePath(fileName, 'tenant-a', 'custom/exports')).toContain('custom/exports/tenants/tenant-a');
    expect(buildWorkerExportSavePath('D:/runtime/storage/uploads', 'tenant-a')).toContain('tenant-a');
  });
});
