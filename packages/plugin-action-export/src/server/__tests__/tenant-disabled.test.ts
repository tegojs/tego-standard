/**
 * Regression tests: module-tenant NOT loaded – plugin-action-export helpers.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * Export helpers must degrade gracefully: no tenant filter, no tenant path segments,
 * no security alerts.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { exportXlsx } from '../actions/export-xlsx';
import ExportPlugin from '../index';
import {
  buildExportDownloadName,
  buildWorkerExportFileName,
  buildWorkerExportRelativePath,
  buildWorkerExportSavePath,
  getExportTenantId,
} from '../utils';

// Mock render and xlsx to avoid heavy I/O
vi.mock('../renders', () => ({
  default: vi.fn().mockResolvedValue({ rows: [['header']], ranges: [] }),
}));
vi.mock('node-xlsx', () => ({
  default: { build: vi.fn().mockReturnValue(Buffer.from('fake-xlsx')) },
}));

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('export helpers – tenant module NOT loaded', () => {
  it('getExportTenantId returns undefined when ctx.state has no tenant info', () => {
    const ctx = { state: {} };
    expect(getExportTenantId(ctx)).toBeUndefined();
  });

  it('getExportTenantId returns undefined when ctx.state is empty object', () => {
    expect(getExportTenantId({ state: {} })).toBeUndefined();
  });

  it('getExportTenantId returns undefined for completely empty source', () => {
    expect(getExportTenantId({})).toBeUndefined();
  });

  it('buildExportDownloadName omits tenant suffix when tenantId is undefined', () => {
    expect(buildExportDownloadName('My Report')).toBe('My Report');
    expect(buildExportDownloadName('My Report', undefined)).toBe('My Report');
  });

  it('buildWorkerExportFileName omits tenant suffix when tenantId is undefined', () => {
    const name = buildWorkerExportFileName('orders', 'Export');
    expect(name).not.toContain('tenants');
    expect(name).toMatch(/^Export_.*\.xlsx$/);
  });

  it('buildWorkerExportRelativePath returns base path without tenants/ segment', () => {
    const p = buildWorkerExportRelativePath('export.xlsx', undefined);
    expect(p).toBe('storage/uploads/export.xlsx');
    expect(p).not.toContain('tenants');
  });

  it('buildWorkerExportSavePath returns root path without tenants/ segment', () => {
    const p = buildWorkerExportSavePath('/tmp/exports', undefined);
    expect(p).toBe('/tmp/exports');
    expect(p).not.toContain('tenants');
  });

  it('sanitizes tenantId before using it in worker file paths', () => {
    expect(buildWorkerExportRelativePath('export.xlsx', '../evil')).toBe('storage/uploads/tenants/.._evil/export.xlsx');
    expect(buildWorkerExportRelativePath('export.xlsx', '..')).toBe('storage/uploads/tenants/export/export.xlsx');
    expect(buildWorkerExportSavePath('/tmp/exports', '..')).toBe(path.join('/tmp/exports', 'tenants', 'export'));
  });
});

// ---------------------------------------------------------------------------
// exportXlsx action – no tenant context
// ---------------------------------------------------------------------------

function createMockCtxWithoutTenant(count: number) {
  const mockCollection = {
    hasField: vi.fn().mockReturnValue(true),
    getField: vi.fn().mockReturnValue(null),
    fields: {
      get: vi.fn().mockReturnValue({ name: 'id', type: 'integer', options: { interface: 'input' } }),
    },
  };
  const mockRepository = {
    collection: mockCollection,
    count: vi.fn().mockResolvedValue(count),
    find: vi.fn().mockResolvedValue([]),
  };
  const emitted: Array<{ event: string; payload: any }> = [];

  const ctx: any = {
    action: {
      params: {
        filter: {},
        title: 'Test Export',
        columns: [{ dataIndex: ['id'], title: 'ID' }],
      },
      resourceName: 'orders',
      resourceOf: undefined,
    },
    state: {
      // NO currentTenant, NO currentTenantId, NO currentTenancyMode
      currentUser: { id: 1 },
    },
    db: {
      getRepository: vi.fn().mockReturnValue(mockRepository),
      getCollection: vi.fn().mockReturnValue(mockCollection),
    },
    app: {
      emit: vi.fn().mockImplementation((event: string, payload: any) => {
        emitted.push({ event, payload });
      }),
    },
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    tego: {},
  };

  return { ctx, emitted, mockRepository };
}

const next = vi.fn().mockResolvedValue(undefined);

describe('exportXlsx action – tenant module NOT loaded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should complete export without errors when no tenant context', async () => {
    const { ctx } = createMockCtxWithoutTenant(10);
    ctx.throw = vi.fn().mockImplementation((status: number, msg: string) => {
      throw new Error(msg);
    });
    await expect(exportXlsx(ctx, next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalled();
  });

  it('should NOT emit security violation even with large count', async () => {
    const { ctx, emitted } = createMockCtxWithoutTenant(5000);
    ctx.throw = vi.fn().mockImplementation((status: number, msg: string) => {
      throw new Error(msg);
    });
    try {
      await exportXlsx(ctx, next);
    } catch {
      // Expected: count > EXPORT_LENGTH_MAX with no worker → ctx.throw(400)
    }
    // Even though export may have thrown, no security violation should be emitted
    expect(emitted).toHaveLength(0);
  });

  it('should produce download name without tenant suffix', async () => {
    const { ctx } = createMockCtxWithoutTenant(5);
    await exportXlsx(ctx, next);

    // ctx.set was called with Content-Disposition
    expect(ctx.set).toHaveBeenCalled();
    const setCall = ctx.set.mock.calls[0][0];
    const disposition = setCall['Content-Disposition'];
    // Content-Disposition uses encodeURI on the title
    expect(disposition).toContain(encodeURI('Test Export'));
    // Should NOT contain tenant suffix (e.g. "_tenant-a")
    expect(disposition).not.toMatch(/_tenant/);
  });
});

// ---------------------------------------------------------------------------
// workerExportXlsx – tenant module NOT loaded
// ---------------------------------------------------------------------------

describe('workerExportXlsx – tenant module NOT loaded', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-td-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should not produce tenants/ path or tenant filter when tenantContext & currentTenantId are absent', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const repository = {
      collection: {
        options: {
          // No tenancy or shared – simulates module-tenant not loaded
          tenancy: 'shared',
        },
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: { interface: 'input' },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find,
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    const result = await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
      title: 'Export',
      filter: { status: 'published' },
      columns: [
        {
          dataIndex: ['title'],
          defaultTitle: 'Title',
          title: 'Title',
        },
      ],
      resourceName: 'orders',
      // NO tenantContext, NO currentTenantId
    });

    // 1. Returned relative path must not contain tenants/
    expect(result).not.toContain('tenants');

    // 2. File should exist and NOT be under a tenants/<id> directory
    const expectedFile = path.join(tempDir, result.replace('storage/uploads/', ''));
    expect(existsSync(expectedFile)).toBe(true);
    expect(expectedFile).not.toMatch(/tenants[/\\]/);

    // 3. repository.find context must NOT contain currentTenantId
    expect(find).toHaveBeenCalled();
    const findArg = find.mock.calls[0][0];
    expect(findArg.context).toBeUndefined();

    // 4. filter must NOT be appended with a tenantId condition
    expect(findArg.filter).toEqual({ status: 'published' });
    expect(findArg.filter).not.toHaveProperty('tenantId');
    const filterStr = JSON.stringify(findArg.filter);
    expect(filterStr).not.toContain('tenantId');
  });

  it('should not produce tenants/ path when collection has no tenancy option at all', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const repository = {
      collection: {
        options: {},
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: { interface: 'input' },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find,
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    const result = await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
      title: 'Export',
      filter: {},
      columns: [
        {
          dataIndex: ['title'],
          defaultTitle: 'Title',
          title: 'Title',
        },
      ],
      resourceName: 'orders',
      // NO tenantContext, NO currentTenantId
    });

    expect(result).not.toContain('tenants');
    const findArg = find.mock.calls[0][0];
    expect(findArg.context).toBeUndefined();
    const filterStr = JSON.stringify(findArg.filter);
    expect(filterStr).not.toContain('tenantId');
  });
});
