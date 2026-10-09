import { describe, expect, it, vi } from 'vitest';

import { scopeCustomQuery } from '../actions/query';

describe('custom chart query scope', () => {
  it('merges role and tenant filters into custom summary requests', async () => {
    const next = vi.fn();
    const ctx = {
      state: {
        currentRole: 'member',
        currentTenantId: 'tenant-a',
      },
      db: {
        getCollection: vi.fn().mockReturnValue({ options: { tenancy: 'tenantScoped' } }),
      },
      tego: {
        acl: {
          can: vi.fn().mockReturnValue({ params: { filter: { ownerId: 7 } } }),
        },
      },
      get: vi.fn().mockImplementation((name: string) => (name === 'x-chart-custom-query' ? 'true' : undefined)),
      action: {
        resourceName: 'records',
        params: {
          values: {
            collection: 'records',
            filter: { status: 'pending' },
          },
        },
      },
    } as any;

    await scopeCustomQuery(ctx, next);

    expect(ctx.action.params.values.filter).toEqual({
      $and: [{ $and: [{ status: 'pending' }, { ownerId: 7 }] }, { tenantId: 'tenant-a' }],
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses the action resource instead of a client-supplied collection name', async () => {
    const next = vi.fn();
    const can = vi.fn().mockReturnValue({ params: {} });
    const ctx = {
      state: {
        currentRole: 'member',
        currentTenantId: 'tenant-a',
      },
      db: {
        getCollection: vi
          .fn()
          .mockImplementation((name: string) =>
            name === 'records' ? { options: { tenancy: 'tenantScoped' } } : undefined,
          ),
      },
      tego: {
        acl: {
          can,
        },
      },
      get: vi.fn().mockImplementation((name: string) => (name === 'x-chart-custom-query' ? 'true' : undefined)),
      action: {
        resourceName: 'records',
        params: {
          values: {
            collection: 'users',
            dataSource: 'main',
            filter: {},
          },
        },
      },
    } as any;

    await scopeCustomQuery(ctx, next);

    expect(can).toHaveBeenCalledWith({ role: 'member', resource: 'records', action: 'list' });
    expect(ctx.action.params.values.collection).toBe('records');
    expect(ctx.action.params.values.filter).toEqual({ tenantId: 'tenant-a' });
  });

  it('rejects custom summaries whose action resource is not a collection', async () => {
    const next = vi.fn();
    const ctx = {
      state: {
        currentRole: 'member',
        currentTenantId: 'tenant-a',
      },
      db: {
        getCollection: vi.fn().mockReturnValue(undefined),
      },
      get: vi.fn().mockReturnValue(undefined),
      throw: vi.fn((status: number, message: string) => {
        const error = new Error(message);
        error['status'] = status;
        throw error;
      }),
      action: {
        resourceName: 'customRequests',
        params: {
          values: {
            collection: 'users',
            dataSource: 'main',
            filter: {},
          },
        },
      },
    } as any;

    await expect(scopeCustomQuery(ctx, next)).rejects.toMatchObject({
      message: 'Custom chart queries must target a collection resource',
      status: 400,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('scopes custom summary requests even when the client marker header is missing', async () => {
    const next = vi.fn();
    const ctx = {
      state: {
        currentRole: 'member',
        currentTenantId: 'tenant-a',
      },
      db: {
        getCollection: vi.fn().mockReturnValue({ options: { tenancy: 'tenantScoped' } }),
      },
      tego: {
        acl: {
          can: vi.fn().mockReturnValue({ params: { filter: { ownerId: 7 } } }),
        },
      },
      get: vi.fn().mockReturnValue(undefined),
      action: {
        resourceName: 'records',
        params: {
          values: {
            collection: 'records',
            dataSource: 'main',
            filter: { status: 'pending' },
          },
        },
      },
    } as any;

    await scopeCustomQuery(ctx, next);

    expect(ctx.action.params.values.filter).toEqual({
      $and: [{ $and: [{ status: 'pending' }, { ownerId: 7 }] }, { tenantId: 'tenant-a' }],
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not change unrelated custom action requests', async () => {
    const next = vi.fn();
    const ctx = {
      get: vi.fn().mockReturnValue(undefined),
      action: {
        resourceName: 'records',
        params: {
          values: {
            filter: { status: 'pending' },
          },
        },
      },
    } as any;

    await scopeCustomQuery(ctx, next);

    expect(ctx.action.params.values.filter).toEqual({ status: 'pending' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not duplicate the built-in charts query pipeline', async () => {
    const next = vi.fn();
    const can = vi.fn();
    const ctx = {
      state: {
        currentRole: 'member',
        currentTenantId: 'tenant-a',
      },
      db: {
        getCollection: vi.fn().mockReturnValue({ options: { tenancy: 'tenantScoped' } }),
      },
      tego: {
        acl: { can },
      },
      get: vi.fn().mockReturnValue(undefined),
      action: {
        resourceName: 'charts',
        actionName: 'query',
        params: {
          values: {
            collection: 'records',
            dataSource: 'main',
            filter: { status: 'pending' },
          },
        },
      },
    } as any;

    await scopeCustomQuery(ctx, next);

    expect(can).not.toHaveBeenCalled();
    expect(ctx.action.params.values.filter).toEqual({ status: 'pending' });
    expect(next).toHaveBeenCalledOnce();
  });
});
