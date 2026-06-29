import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
