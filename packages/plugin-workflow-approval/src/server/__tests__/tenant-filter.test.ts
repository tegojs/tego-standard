import { withCurrentTenantFilter } from '../helpers/tenant-filter';

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
});
