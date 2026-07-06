import {
  getTenantValuesFromContext,
  getTenantValuesFromExecution,
  withCurrentTenantFilter,
} from '../helpers/tenant-filter';

describe('workflow approval tenant filter helper', () => {
  it('should return original filter when tenant context is absent', () => {
    const filter = { status: 1 };

    expect(withCurrentTenantFilter({ state: {} }, filter)).toEqual(filter);
  });

  it('should append current tenant filter', () => {
    expect(withCurrentTenantFilter({ state: { currentTenantId: 'tenant-a' } }, { status: 1 })).toEqual({
      $and: [{ status: 1 }, { tenantId: 'tenant-a' }],
    });
  });

  it('should strip caller-provided tenant filters before enforcing current tenant', () => {
    expect(
      withCurrentTenantFilter(
        { state: { currentTenantId: 'tenant-a' } },
        { status: 1, tenantId: 'tenant-b', 'tenantId.$ne': 'tenant-a' },
      ),
    ).toEqual({
      $and: [{ status: 1 }, { tenantId: 'tenant-a' }],
    });
  });

  it('should preserve symbol-keyed operators when stripping tenant filters', () => {
    const operator = Symbol.for('ne');
    const filter = {
      status: {
        [operator]: 'rejected',
      },
      tenantId: 'tenant-b',
    };

    const result = withCurrentTenantFilter({ state: { currentTenantId: 'tenant-a' } }, filter);

    expect(result.$and[0].status[operator]).toBe('rejected');
    expect(result).toEqual({
      $and: [
        {
          status: {
            [operator]: 'rejected',
          },
        },
        { tenantId: 'tenant-a' },
      ],
    });
  });

  it('should use inherited tenant scope from the configured approval collection', () => {
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
        currentTenantDescendantIds: ['tenant-b'],
      },
      action: {
        resourceName: 'approvals',
      },
      db: {
        getCollection: () => ({
          options: {
            tenancy: 'tenantInherited',
          },
        }),
      },
    };

    expect(withCurrentTenantFilter(ctx, { status: 1 })).toEqual({
      $and: [{ status: 1 }, { tenantId: { $in: ['tenant-a', 'tenant-b'] } }],
    });
  });

  it('should not append a tenant filter when the configured approval collection is shared', () => {
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
      },
      action: {
        resourceName: 'approvals',
      },
      db: {
        getCollection: () => ({
          options: {
            tenancy: 'shared',
          },
        }),
      },
    };

    expect(withCurrentTenantFilter(ctx, { status: 1 })).toEqual({ status: 1 });
  });

  it('should not write tenantId when the configured approval collection is shared', () => {
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
      },
      db: {
        getCollection: () => ({
          options: {
            tenancy: 'shared',
          },
        }),
      },
    };

    expect(getTenantValuesFromContext(ctx, 'approvals')).toEqual({});
  });

  it('should write tenantId from execution only when the target approval runtime collection is tenant enabled', () => {
    const execution = {
      tenantId: 'tenant-a',
      constructor: {
        database: {
          getCollection: () => ({
            options: {
              tenancy: 'shared',
            },
          }),
        },
      },
    };

    expect(getTenantValuesFromExecution(execution, 'approvalRecords')).toEqual({});
  });
});
