import applyTenantFilter, { applyTenantFilterToContext } from '../helpers/tenant-filter';

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

  it('should include legacy records for read actions when the current tenant is allowed', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
        currentLegacyDataTenantIds: ['tenant-a'],
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
        $and: [
          { status: 'published' },
          {
            $or: [{ tenantId: 'tenant-a' }, { tenantId: null }],
          },
        ],
      },
    });
  });

  it('should not include legacy records for update actions', () => {
    const mergeParams = vi.fn();
    const ctx = {
      state: {
        currentTenantId: 'tenant-a',
        currentLegacyDataTenantIds: ['tenant-a'],
      },
      action: {
        actionName: 'update',
        params: {
          filter: {
            status: 'draft',
          },
          values: {
            title: 'Post',
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
        tenantId: 'tenant-a',
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
    expect('filter' in ctx.action.params).toBe(false);
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
    expect(ctx.action.params.values).toEqual({
      title: 'Post',
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

  describe('applyTenantFilterToContext', () => {
    it('should merge tenant filter into repository read options', () => {
      const options = applyTenantFilterToContext(
        {
          state: {
            currentTenantId: 'tenant-a',
          },
        },
        {
          options: {
            tenancy: 'tenantScoped',
          },
        },
        'list',
        {
          filter: {
            status: 'published',
          },
        },
      );

      expect(options).toMatchObject({
        filter: {
          $and: [{ status: 'published' }, { tenantId: 'tenant-a' }],
        },
      });
    });

    it('should remove tenantId from repository update values and keep write filter scoped', () => {
      const options = applyTenantFilterToContext(
        {
          state: {
            currentTenantId: 'tenant-a',
          },
        },
        {
          options: {
            tenancy: 'tenantScoped',
          },
        },
        'update',
        {
          filter: {
            title: 'same-title',
          },
          values: {
            title: 'updated',
            tenantId: 'tenant-b',
          },
        },
      );

      expect(options).toMatchObject({
        filter: {
          $and: [{ title: 'same-title' }, { tenantId: 'tenant-a' }],
        },
        values: {
          title: 'updated',
        },
      });
    });

    it('should use current tenant and descendants for inherited repository reads', () => {
      const options = applyTenantFilterToContext(
        {
          state: {
            currentTenantId: 'parent-a',
            currentTenantDescendantIds: ['child-a'],
          },
        },
        {
          options: {
            tenancy: 'tenantInherited',
          },
        },
        'aggregate',
        {
          filter: {
            status: 'published',
          },
        },
      );

      expect(options).toMatchObject({
        filter: {
          $and: [{ status: 'published' }, { tenantId: { $in: ['parent-a', 'child-a'] } }],
        },
      });
    });

    it('should leave shared collection repository options unchanged', () => {
      const options = {
        filter: {
          title: 'shared',
        },
      };

      expect(
        applyTenantFilterToContext(
          {
            state: {
              currentTenantId: 'tenant-a',
            },
          },
          {
            options: {
              tenancy: 'shared',
            },
          },
          'list',
          options,
        ),
      ).toBe(options);
    });
  });
});
