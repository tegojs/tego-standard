import { guardLegacyTenantClaimUpdate } from '../helpers/legacy-data-claim';

function createContext(tenantId = 'tenant-a') {
  return {
    state: {
      currentTenant: { id: tenantId },
      currentTenantId: tenantId,
    },
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  };
}

function createClaimFixture(lockedTenantId: string | null) {
  const findOne = vi.fn().mockResolvedValue({
    get: vi.fn((key: string) => (key === 'tenantId' ? lockedTenantId : undefined)),
  });
  const Model = { findOne };
  const model = {
    constructor: Model,
    changed: vi.fn((key: string) => key === 'tenantId'),
    get: vi.fn((key: string) => ({ id: 7, tenantId: 'tenant-a' })[key]),
    previous: vi.fn((key: string) => (key === 'tenantId' ? null : undefined)),
  };
  const collection = {
    filterTargetKey: 'id',
    options: {
      tenancy: 'tenantScoped',
      legacyDataTenantIds: ['tenant-a'],
      allowEditingLegacyData: true,
    },
  };
  const db = {
    modelCollection: {
      get: vi.fn(() => collection),
    },
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };

  return { db, findOne, model, transaction };
}

describe('guardLegacyTenantClaimUpdate', () => {
  it('should lock and recheck the unassigned row in the current update transaction', async () => {
    const { db, findOne, model, transaction } = createClaimFixture(null);

    await guardLegacyTenantClaimUpdate(db as any, model as any, {
      context: createContext(),
      transaction,
    });

    expect(findOne).toHaveBeenCalledWith({
      attributes: ['tenantId'],
      where: { id: 7 },
      transaction,
      lock: 'UPDATE',
    });
  });

  it('should reject a stale claim after another tenant has claimed the row', async () => {
    const { db, model, transaction } = createClaimFixture('tenant-b');

    await expect(
      guardLegacyTenantClaimUpdate(db as any, model as any, {
        context: createContext(),
        transaction,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('should reject a stale tenant assignment without tenant context', async () => {
    const { db, findOne, model, transaction } = createClaimFixture('tenant-b');

    await expect(
      guardLegacyTenantClaimUpdate(db as any, model as any, {
        transaction,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(findOne).toHaveBeenCalledOnce();
  });

  it('should lock and allow an unassigned tenant assignment without tenant context', async () => {
    const { db, findOne, model, transaction } = createClaimFixture(null);

    await guardLegacyTenantClaimUpdate(db as any, model as any, {
      transaction,
    });

    expect(findOne).toHaveBeenCalledOnce();
  });
});
