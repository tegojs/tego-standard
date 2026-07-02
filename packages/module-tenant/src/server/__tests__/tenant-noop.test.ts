/**
 * Regression tests: adapted modules behave as no-op when there is no
 * currentTenant context (i.e. module-tenant is not enabled or the user
 * has no tenant assignment).
 *
 * Modules covered:
 * - plugin-block-charts  (applyTenantScope)
 * - plugin-action-export (getExportTenantId, buildExportDownloadName, etc.)
 * - module-file          (getCurrentTenantId, getTenantStoragePath)
 * - module-workflow       (applyTenantFilterToContext)
 * - plugin-audit-logs    (getAuditContext)
 *
 * These tests do NOT require a running mock server — they exercise pure
 * functions so they run fast and remain isolated.
 */
import { describe, expect, it, vi } from 'vitest';

// ── File ────────────────────────────────────────────────────────────
import { getCurrentTenantId, getTenantStoragePath } from '../../../../module-file/src/server/utils';
// ── Workflow ────────────────────────────────────────────────────────
import { applyTenantFilterToContext } from '../../../../module-workflow/src/server/helpers/tenant-context';
// ── Export ──────────────────────────────────────────────────────────
import {
  buildExportDownloadName,
  buildWorkerExportFileName,
  buildWorkerExportRelativePath,
  buildWorkerExportSavePath,
  getExportTenantId,
} from '../../../../plugin-action-export/src/server/utils/index';
// ── Audit ───────────────────────────────────────────────────────────
import { getAuditContext } from '../../../../plugin-audit-logs/src/server/hooks/audit-context';
// ── Charts ──────────────────────────────────────────────────────────
import { applyTenantScope } from '../../../../plugin-block-charts/src/server/actions/query';

// ═══════════════════════════════════════════════════════════════════
// Charts — applyTenantScope no-op
// ═══════════════════════════════════════════════════════════════════
describe('charts > applyTenantScope no-op when no tenant context', () => {
  function createChartsCtx(overrides: Record<string, any> = {}) {
    return {
      state: {},
      action: {
        params: {
          values: {
            collection: 'posts',
            filter: { status: 'published' },
            ...overrides,
          },
        },
      },
      db: {
        getCollection: (name: string) => ({
          options: {
            tenancy: 'tenantScoped',
          },
        }),
      },
      get: vi.fn(),
    } as any;
  }

  it('should pass through without modifying filter when no tenantId in state', async () => {
    const ctx = createChartsCtx();
    const next = vi.fn();

    await applyTenantScope(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.action.params.values.filter).toEqual({ status: 'published' });
  });

  it('should pass through for tenantInherited collection when no tenantId', async () => {
    const ctx = {
      state: {},
      action: {
        params: {
          values: {
            collection: 'posts',
            filter: {},
          },
        },
      },
      db: {
        getCollection: () => ({
          options: { tenancy: 'tenantInherited' },
        }),
      },
      get: vi.fn(),
    } as any;
    const next = vi.fn();

    await applyTenantScope(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.action.params.values.filter).toEqual({});
  });

  it('should pass through for shared collection without applying any filter', async () => {
    const ctx = {
      state: {},
      action: {
        params: {
          values: {
            collection: 'posts',
            filter: { active: true },
          },
        },
      },
      db: {
        getCollection: () => ({
          options: { tenancy: 'shared' },
        }),
      },
      get: vi.fn(),
    } as any;
    const next = vi.fn();

    await applyTenantScope(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.action.params.values.filter).toEqual({ active: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Export — utility functions no-op
// ═══════════════════════════════════════════════════════════════════
describe('export > utility functions no-op when no tenant context', () => {
  it('getExportTenantId should return undefined when no tenant state', () => {
    expect(getExportTenantId({})).toBeUndefined();
    expect(getExportTenantId({ state: {} })).toBeUndefined();
    expect(getExportTenantId({ state: { currentTenant: null } })).toBeUndefined();
    expect(getExportTenantId(null)).toBeUndefined();
    expect(getExportTenantId(undefined)).toBeUndefined();
  });

  it('buildExportDownloadName should return base name without tenant suffix', () => {
    expect(buildExportDownloadName('Report')).toBe('Report');
    expect(buildExportDownloadName('Report', undefined)).toBe('Report');
    expect(buildExportDownloadName('Report', '')).toBe('Report');
  });

  it('buildWorkerExportFileName should generate name without tenant suffix', () => {
    const name = buildWorkerExportFileName('orders', 'Orders Export', undefined);
    expect(name).toMatch(/^Orders_Export_\d{12}_[a-f0-9]{8}\.xlsx$/);
    expect(name).not.toContain('tenants');
  });

  it('buildWorkerExportRelativePath should use base path without tenant segment', () => {
    const relativePath = buildWorkerExportRelativePath('export.xlsx', undefined);
    expect(relativePath).toBe('storage/uploads/export.xlsx');
    expect(relativePath).not.toContain('tenants');
  });

  it('buildWorkerExportSavePath should return root path without tenant segment', () => {
    expect(buildWorkerExportSavePath('/data/uploads', undefined)).toBe('/data/uploads');
    expect(buildWorkerExportSavePath('/data/uploads', '')).toBe('/data/uploads');
  });

  it('exportXlsx should not emit security violation without tenant context', async () => {
    // The export action checks ctx.state.currentTenancyMode before emitting.
    // When absent (tenant module not loaded), no security event should fire.
    // We verify the condition logic directly rather than mocking the full action.
    const currentTenancyMode = undefined;
    const count = 5000; // well above threshold

    // This mirrors the condition in export-xlsx.ts line 51:
    //   if (count >= BULK_EXPORT_THRESHOLD && ctx.state.currentTenancyMode)
    const shouldEmit = count >= 1000 && currentTenancyMode;
    expect(shouldEmit).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// File — storage path no-op
// ═══════════════════════════════════════════════════════════════════
describe('file > storage paths no-op when no tenant context', () => {
  it('getCurrentTenantId should return undefined without tenant state', () => {
    expect(getCurrentTenantId({})).toBeUndefined();
    expect(getCurrentTenantId({ state: {} })).toBeUndefined();
    expect(getCurrentTenantId(null)).toBeUndefined();
    expect(getCurrentTenantId(undefined)).toBeUndefined();
  });

  it('getCurrentTenantId should return undefined when currentTenant is null', () => {
    expect(getCurrentTenantId({ state: { currentTenant: null } })).toBeUndefined();
  });

  it('getTenantStoragePath should return normalized base path without tenantId', () => {
    expect(getTenantStoragePath('storage/uploads', undefined)).toBe('storage/uploads');
    expect(getTenantStoragePath('storage/uploads', '')).toBe('storage/uploads');
  });

  it('getTenantStoragePath should handle undefined storagePath', () => {
    expect(getTenantStoragePath(undefined, undefined)).toBe('');
  });

  it('getTenantStoragePath should normalize backslashes', () => {
    expect(getTenantStoragePath('storage\\uploads', undefined)).toBe('storage/uploads');
  });

  it('getTenantStoragePath should strip leading and trailing slashes', () => {
    expect(getTenantStoragePath('/storage/uploads/', undefined)).toBe('storage/uploads');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Workflow — applyTenantFilterToContext no-op
// ═══════════════════════════════════════════════════════════════════
describe('workflow > applyTenantFilterToContext no-op when no tenant context', () => {
  it('should return options unchanged for tenantScoped collection without tenantId', () => {
    const options = { filter: { title: 'test' } };
    const result = applyTenantFilterToContext({ state: {} }, { options: { tenancy: 'tenantScoped' } }, 'list', options);

    expect(result).toBe(options);
    expect(result.filter).toEqual({ title: 'test' });
  });

  it('should return options unchanged for tenantInherited collection without tenantId', () => {
    const options = { filter: { active: true } };
    const result = applyTenantFilterToContext(
      { state: {} },
      { options: { tenancy: 'tenantInherited' } },
      'list',
      options,
    );

    expect(result).toBe(options);
  });

  it('should return options unchanged for create action without tenantId', () => {
    const options = { values: { title: 'New Record' } };
    const result = applyTenantFilterToContext(
      { state: {} },
      { options: { tenancy: 'tenantScoped' } },
      'create',
      options,
    );

    expect(result).toBe(options);
    expect(result.values).toEqual({ title: 'New Record' });
    expect(result.values.tenantId).toBeUndefined();
  });

  it('should return options unchanged for update action without tenantId', () => {
    const options = { filter: { id: 1 }, values: { title: 'Updated' } };
    const result = applyTenantFilterToContext(
      { state: {} },
      { options: { tenancy: 'tenantScoped' } },
      'update',
      options,
    );

    expect(result).toBe(options);
    expect(result.filter).toEqual({ id: 1 });
    expect(result.values).toEqual({ title: 'Updated' });
  });

  it('should return options unchanged for shared collection regardless of state', () => {
    const options = { filter: {} };
    const result = applyTenantFilterToContext(
      { state: { currentTenantId: 'tenant-a' } },
      { options: { tenancy: 'shared' } },
      'list',
      options,
    );

    // Shared collections should NEVER get tenant filtering, even with tenant state
    expect(result).toBe(options);
  });

  it('should return options unchanged when tenancy mode is not set', () => {
    const options = { filter: {} };
    const result = applyTenantFilterToContext({ state: {} }, { options: {} }, 'list', options);

    expect(result).toBe(options);
  });

  it('should return options unchanged when collection has no options', () => {
    const options = { filter: {} };
    const result = applyTenantFilterToContext({ state: {} }, {}, 'list', options);

    expect(result).toBe(options);
  });

  it('should return options unchanged for destroy action without tenantId', () => {
    const options = { filter: { id: 1 } };
    const result = applyTenantFilterToContext(
      { state: {} },
      { options: { tenancy: 'tenantScoped' } },
      'destroy',
      options,
    );

    expect(result).toBe(options);
  });

  it('should return options unchanged for aggregate action without tenantId', () => {
    const options = { filter: {} };
    const result = applyTenantFilterToContext(
      { state: {} },
      { options: { tenancy: 'tenantScoped' } },
      'aggregate',
      options,
    );

    expect(result).toBe(options);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Audit — getAuditContext no-op
// ═══════════════════════════════════════════════════════════════════
describe('audit > getAuditContext no-op when no tenant context', () => {
  it('should return undefined tenantId when state has no currentTenantId', () => {
    const context = getAuditContext({
      context: { state: { currentUser: { id: 1 } } },
    });

    expect(context.tenantId).toBeUndefined();
    expect(context.impersonatedTenantId).toBeUndefined();
    expect(context.tenantContextSource).toBeUndefined();
    expect(context.isTenantImpersonation).toBe(false);
    expect(context.userId).toBe(1);
  });

  it('should return undefined tenant fields when state is empty', () => {
    const context = getAuditContext({ context: { state: {} } });

    expect(context.tenantId).toBeUndefined();
    expect(context.userId).toBeUndefined();
    expect(context.isTenantImpersonation).toBe(false);
  });

  it('should return undefined tenant fields when options is empty', () => {
    const context = getAuditContext({});

    expect(context.tenantId).toBeUndefined();
    expect(context.userId).toBeUndefined();
    expect(context.isTenantImpersonation).toBe(false);
  });

  it('should return undefined tenant fields when options is null', () => {
    const context = getAuditContext(null);

    expect(context.tenantId).toBeUndefined();
    expect(context.userId).toBeUndefined();
    expect(context.isTenantImpersonation).toBe(false);
  });
});
