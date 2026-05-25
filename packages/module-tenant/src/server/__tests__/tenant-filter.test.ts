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

  it('should merge tenant filter for export actions', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
      },
      action: {
        actionName: 'export',
        params: {
          filter: {
            tenantId: 'tenant-b',
          },
        },
        mergeParams,
      },
    };

    applyTenantFilter(ctx);

    expect(mergeParams).toHaveBeenCalledWith({
      filter: {
        $and: [{ tenantId: 'tenant-b' }, { tenantId: 'tenant-a' }],
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

  it('should inject tenantId into every record for array create values', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenantId: 'tenant-c',
      },
      action: {
        actionName: 'create',
        params: {
          values: [{ title: 'Post 1' }, { title: 'Post 2', tenantId: 'tenant-x' }],
        },
        mergeParams,
      },
    };

    applyTenantFilter(ctx);

    expect(mergeParams).toHaveBeenCalledWith({
      values: [
        {
          title: 'Post 1',
          tenantId: 'tenant-c',
        },
        {
          title: 'Post 2',
          tenantId: 'tenant-c',
        },
      ],
    });
  });

  it('should remove tenantId from update values while keeping the tenant filter', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
      },
      action: {
        actionName: 'update',
        params: {
          filter: {
            status: 'draft',
          },
          values: {
            title: 'Post',
            tenantId: 'tenant-b',
          },
        },
        mergeParams,
      },
    };

    applyTenantFilter(ctx);

    expect(mergeParams).toHaveBeenCalledWith({
      filter: {
        $and: [{ status: 'draft' }, { tenantId: 'tenant-a' }],
      },
      values: {
        title: 'Post',
      },
    });
  });

  describe('tenantInherited mode', () => {
    it('should use $in filter with current tenant + descendants for list actions', () => {
      const mergeParams = vi.fn();
      const ctx = {
        state: {
          currentTenantId: 'parent-a',
          currentTenancyMode: 'tenantInherited',
          currentTenantDescendantIds: ['child-1', 'child-2', 'grandchild-1'],
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
          $and: [{ status: 'published' }, { tenantId: { $in: ['parent-a', 'child-1', 'child-2', 'grandchild-1'] } }],
        },
      });
    });

    it('should use $in filter for export actions in inherited mode', () => {
      const mergeParams = vi.fn();
      const ctx = {
        state: {
          currentTenantId: 'parent-a',
          currentTenancyMode: 'tenantInherited',
          currentTenantDescendantIds: ['child-1'],
        },
        action: {
          actionName: 'export',
          params: {
            filter: {},
          },
          mergeParams,
        },
      };

      applyTenantFilter(ctx);

      expect(mergeParams).toHaveBeenCalledWith({
        filter: {
          tenantId: { $in: ['parent-a', 'child-1'] },
        },
      });
    });

    it('should still inject current tenantId on create in inherited mode', () => {
      const mergeParams = vi.fn();
      const ctx = {
        state: {
          currentTenantId: 'parent-a',
          currentTenancyMode: 'tenantInherited',
          currentTenantDescendantIds: ['child-1'],
        },
        action: {
          actionName: 'create',
          params: {
            values: { title: 'New Post' },
          },
          mergeParams,
        },
      };

      applyTenantFilter(ctx);

      expect(mergeParams).toHaveBeenCalledWith({
        values: {
          title: 'New Post',
          tenantId: 'parent-a',
        },
      });
    });

    it('should handle empty descendants list', () => {
      const mergeParams = vi.fn();
      const ctx = {
        state: {
          currentTenantId: 'leaf-a',
          currentTenancyMode: 'tenantInherited',
          currentTenantDescendantIds: [],
        },
        action: {
          actionName: 'list',
          params: { filter: {} },
          mergeParams,
        },
      };

      applyTenantFilter(ctx);

      expect(mergeParams).toHaveBeenCalledWith({
        filter: {
          tenantId: { $in: ['leaf-a'] },
        },
      });
    });
  });
});
