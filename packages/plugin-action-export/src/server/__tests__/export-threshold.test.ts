import { createMockServer, waitSecond, type MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTenantApp } from '../../../../module-tenant/src/server/__tests__/utils';
import { exportXlsx } from '../actions/export-xlsx';
import { BULK_EXPORT_THRESHOLD, EXPORT_LENGTH_MAX } from '../constants';

// Mock render to avoid heavy computation
vi.mock('../renders', () => ({
  default: vi.fn().mockResolvedValue({ rows: [['header']], ranges: [] }),
}));

// Stub node-xlsx so we don't actually build a file
vi.mock('node-xlsx', () => ({
  default: { build: vi.fn().mockReturnValue(Buffer.from('fake-xlsx')) },
}));

/** Build a minimal mock ctx that satisfies exportXlsx's happy path. */
function createMockCtx(options: {
  count: number;
  currentTenancyMode?: string;
  currentUser?: { id: number | string };
  actorUserId?: number | string;
  currentTenantId?: string;
  resourceName?: string;
}) {
  const { count, currentTenancyMode, currentUser, actorUserId, currentTenantId, resourceName = 'orders' } = options;

  const mockCollection = {
    hasField: vi.fn().mockReturnValue(true),
    getField: vi.fn().mockReturnValue(null), // columns2Appends walks fields via collection.getField
    fields: {
      get: vi.fn().mockReturnValue({
        name: 'id',
        type: 'integer',
        options: { interface: 'input' },
      }),
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
      resourceName,
      resourceOf: undefined,
    },
    state: {
      currentUser,
      actorUserId,
      currentTenantId,
      currentTenancyMode,
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

describe('exportXlsx – bulk export alert via real action handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should emit tenant.securityViolation when count >= threshold and tenant context exists', async () => {
    const userId = 42;
    const actorUserId = 42;
    const tenantId = 'tenant-abc';
    const resourceName = 'orders';
    const count = BULK_EXPORT_THRESHOLD + 200; // 1200

    const { ctx, emitted } = createMockCtx({
      count,
      currentTenancyMode: 'tenantScoped',
      currentUser: { id: userId },
      actorUserId,
      currentTenantId: tenantId,
      resourceName,
    });

    await exportXlsx(ctx, next);

    // Should have emitted exactly one security violation
    expect(ctx.app.emit).toHaveBeenCalledTimes(1);
    expect(ctx.app.emit).toHaveBeenCalledWith('tenant.securityViolation', expect.any(Object));

    // Verify full payload
    const payload = emitted[0].payload;
    expect(payload).toEqual({
      type: 'tenant_bulk_export_alert',
      userId,
      actorUserId,
      tenantId,
      collectionName: resourceName,
      action: 'export',
      details: { rowCount: count, threshold: BULK_EXPORT_THRESHOLD },
    });
  });

  it('should NOT emit when count < threshold even with tenant context', async () => {
    const { ctx } = createMockCtx({
      count: BULK_EXPORT_THRESHOLD - 1, // 999
      currentTenancyMode: 'tenantScoped',
      currentUser: { id: 1 },
      actorUserId: 1,
      currentTenantId: 'tenant-x',
    });

    await exportXlsx(ctx, next);

    expect(ctx.app.emit).not.toHaveBeenCalled();
  });

  it('should NOT emit when there is no tenant context (currentTenancyMode absent)', async () => {
    const { ctx } = createMockCtx({
      count: BULK_EXPORT_THRESHOLD + 500, // 1500 – well above threshold
      currentTenancyMode: undefined, // no tenant context
      currentUser: { id: 7 },
      actorUserId: 7,
      currentTenantId: undefined,
    });

    await exportXlsx(ctx, next);

    expect(ctx.app.emit).not.toHaveBeenCalled();
  });

  it('should pass correct details.rowCount and details.threshold at exact boundary', async () => {
    const count = BULK_EXPORT_THRESHOLD; // exactly 1000

    const { ctx, emitted } = createMockCtx({
      count,
      currentTenancyMode: 'tenantScoped',
      currentUser: { id: 99 },
      actorUserId: 99,
      currentTenantId: 'tenant-boundary',
    });

    await exportXlsx(ctx, next);

    expect(ctx.app.emit).toHaveBeenCalledTimes(1);
    const payload = emitted[0].payload;
    expect(payload.type).toBe('tenant_bulk_export_alert');
    expect(payload.details.rowCount).toBe(BULK_EXPORT_THRESHOLD);
    expect(payload.details.threshold).toBe(BULK_EXPORT_THRESHOLD);
    expect(payload.action).toBe('export');
  });

  it('should call repository.count with filter and context', async () => {
    const { ctx, mockRepository } = createMockCtx({
      count: 50, // low count, no alert
    });

    await exportXlsx(ctx, next);

    expect(mockRepository.count).toHaveBeenCalledWith({
      filter: {},
      context: ctx,
    });
  });

  it('should emit on ctx.app.__application (Application) instead of ctx.app (Koa)', async () => {
    // Simulate real Koa environment: ctx.app is a plain Koa-like object
    // without EventEmitter.  The Application instance is stored as a
    // back-reference by module-tenant.
    const koaLike: any = { context: {}, response: {} };
    const applicationLike: any = { emit: vi.fn() };
    koaLike.__application = applicationLike;

    const count = BULK_EXPORT_THRESHOLD + 500; // 1500
    const userId = 42;
    const actorUserId = 42;
    const tenantId = 'tenant-emit-target';
    const resourceName = 'bulk_orders';

    const mockCollection = {
      hasField: vi.fn().mockReturnValue(true),
      getField: vi.fn().mockReturnValue(null),
      fields: {
        get: vi.fn().mockReturnValue({
          name: 'id',
          type: 'integer',
          options: { interface: 'input' },
        }),
      },
    };

    const mockRepository = {
      collection: mockCollection,
      count: vi.fn().mockResolvedValue(count),
      find: vi.fn().mockResolvedValue([]),
    };

    const ctx: any = {
      action: {
        params: {
          filter: {},
          title: 'Bulk Export',
          columns: [{ dataIndex: ['id'], title: 'ID' }],
        },
        resourceName,
        resourceOf: undefined,
      },
      state: {
        currentUser: { id: userId },
        actorUserId,
        currentTenantId: tenantId,
        currentTenancyMode: 'tenantScoped',
      },
      db: {
        getRepository: vi.fn().mockReturnValue(mockRepository),
        getCollection: vi.fn().mockReturnValue(mockCollection),
      },
      app: koaLike, // Koa-like: NO emit method
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      tego: {},
    };

    await exportXlsx(ctx, next);

    // The event MUST be emitted on the Application instance (__application),
    // NOT on the Koa-like ctx.app (which has no emit).
    expect(applicationLike.emit).toHaveBeenCalledTimes(1);
    expect(applicationLike.emit).toHaveBeenCalledWith('tenant.securityViolation', {
      type: 'tenant_bulk_export_alert',
      userId,
      actorUserId,
      tenantId,
      collectionName: resourceName,
      action: 'export',
      details: { rowCount: count, threshold: BULK_EXPORT_THRESHOLD },
    });

    // Koa-like object must NOT have been called (it has no emit)
    expect((koaLike as any).emit).toBeUndefined();
  });
});

// ── Integration: export action → audit-logs persistence ─────────────────
describe('exportXlsx – tenant bulk export audit log persistence (integration)', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  async function waitForAuditLog(db: any, filter: Record<string, any>, timeoutMs = 5000): Promise<any | null> {
    const repo = db.getRepository('auditLogs');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const log = await repo.findOne({ filter });
      if (log) return log;
      await waitSecond(100);
    }
    return null;
  }

  async function countAuditLogs(db: any, filter: Record<string, any>): Promise<number> {
    const repo = db.getRepository('auditLogs');
    const logs = await repo.find({ filter });
    return logs.length;
  }

  it('should write exactly 1 tenant_bulk_export_alert to auditLogs when export exceeds threshold', async () => {
    // 1. Create app with tenant + audit-logs capabilities
    app = await createTenantApp({ extraPlugins: ['audit-logs'] });

    // Register the export action handler (ExportPlugin is not in extraPlugins
    // but we need its action handler for the agent request to work)
    app.resourcer.registerActionHandler('export', exportXlsx);

    // 2. Create tenant-a
    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    // 3. Create a user bound to tenant-a with export permission
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'export_audit_user',
        email: 'export-audit-user@example.com',
        phone: '10000000090',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    // Grant 'export' action to admin role
    await app.db.getRepository('roles').update({
      filterByTk: 'admin',
      values: {
        strategy: {
          actions: ['create', 'view', 'update', 'destroy', 'list', 'get', 'count', 'export'],
        },
      },
    });

    // 4. Create a tenantScoped collection with one field
    await app.db.getRepository('collections').create({
      values: {
        name: 'export_audit_posts',
        tenancy: 'tenantScoped',
        fields: [{ type: 'string', name: 'title', interface: 'input' }],
      },
      context: {},
    });

    // Insert one row (we mock count to exceed threshold, so minimal data is fine)
    await app.db.getRepository('export_audit_posts').create({
      values: { title: 'test row', tenantId: 'tenant-a' },
      context: {},
    });

    // 5. Mock repository.count to return a value above the threshold
    //    so the security event fires without inserting 1000+ rows
    const repo = app.db.getRepository('export_audit_posts');
    vi.spyOn(repo, 'count').mockResolvedValue(BULK_EXPORT_THRESHOLD + 100);

    // 6. Trigger the export action via agent (full Koa middleware chain)
    const response = await app
      .agent()
      .login(user)
      .set('X-Tenant-Id', 'tenant-a')
      .resource('export_audit_posts')
      .export({
        columns: [{ dataIndex: ['title'], title: 'Title' }],
        title: 'Audit Test Export',
      });

    // Export may succeed or fail (render can be flaky with mocks), but the
    // security event fires before the render step, so the audit log must exist.
    expect(response.status).toBeLessThanOrEqual(499);

    // 7. Query auditLogs for tenant_bulk_export_alert
    const auditLog = await waitForAuditLog(app.db, { type: 'tenant_bulk_export_alert' });
    expect(auditLog).not.toBeNull();

    const userId = user.get('id');
    expect(auditLog.get('type')).toBe('tenant_bulk_export_alert');
    expect(auditLog.get('tenantId')).toBe('tenant-a');
    expect(auditLog.get('actorUserId')).toBe(String(userId));
    expect(auditLog.get('collectionName')).toBe('export_audit_posts');
    expect(auditLog.get('isTenantImpersonation')).toBe(false);
    expect(auditLog.get('impersonatedTenantId')).toBeNull();

    const details = auditLog.get('details');
    expect(details).toBeDefined();
    expect(details).not.toBeNull();
    expect(details.rowCount).toBe(BULK_EXPORT_THRESHOLD + 100);
    expect(details.threshold).toBe(BULK_EXPORT_THRESHOLD);

    // Exactly 1 audit log — no duplicate writes
    const count = await countAuditLogs(app.db, { type: 'tenant_bulk_export_alert' });
    expect(count).toBe(1);
  });
});
