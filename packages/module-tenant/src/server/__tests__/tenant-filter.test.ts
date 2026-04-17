import applyTenantFilter from '../helpers/tenant-filter';

describe('applyTenantFilter', () => {
  it('should merge tenant filter for list actions', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
      },
      action: {
        actionName: 'list',
        params: {
          filter: {
            status: 'published',
          },
        },
        mergeParams,
      },
    };

    applyTenantFilter(ctx);

    expect(mergeParams).toHaveBeenCalledWith({
      filter: {
        $and: [{ status: 'published' }, { tenantId: 'tenant-a' }],
      },
    });
  });

  it('should inject tenantId into create values', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenant: {
          id: 'tenant-b',
        },
      },
      action: {
        actionName: 'create',
        params: {
          values: {
            title: 'Post',
          },
        },
        mergeParams,
      },
    };

    applyTenantFilter(ctx);

    expect(mergeParams).toHaveBeenCalledWith({
      values: {
        title: 'Post',
        tenantId: 'tenant-b',
      },
    });
  });
});
