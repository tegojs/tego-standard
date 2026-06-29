/**
 * Regression tests: module-tenant NOT loaded – plugin-action-export helpers.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * Export helpers must degrade gracefully: no tenant filter, no tenant path segments,
 * no security alerts.
 */
import { describe, expect, it, vi } from 'vitest';

import { exportXlsx } from '../actions/export-xlsx';
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
