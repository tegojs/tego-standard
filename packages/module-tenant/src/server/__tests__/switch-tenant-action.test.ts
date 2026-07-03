import { describe, expect, it, vi } from 'vitest';

import { switchTenant } from '../actions/switch-tenant';

describe('switchTenant action', () => {
  it('should reject unauthenticated requests before tenant repository access', async () => {
    const next = vi.fn();
    const findOne = vi.fn();
    const ctx: any = {
      action: {
        params: {
          values: {
            tenantId: 'tenant-a',
          },
        },
      },
      db: {
        getRepository: vi.fn(() => ({ findOne })),
      },
      state: {},
      throw: vi.fn((status: number, message: string) => {
        const error: any = new Error(message);
        error.status = status;
        throw error;
      }),
    };

    await expect(switchTenant(ctx, next)).rejects.toMatchObject({
      status: 401,
      message: 'Authentication required',
    });
    expect(ctx.db.getRepository).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should allow platform impersonator to switch to an enabled tenant without membership', async () => {
    const next = vi.fn();
    const tenant = {
      get: vi.fn((key: string) => (key === 'id' ? 'tenant-b' : undefined)),
      toJSON: vi.fn(() => ({ id: 'tenant-b', title: 'Tenant B' })),
    };
    const tenantsRepo = {
      findOne: vi.fn().mockResolvedValue(tenant),
    };
    const tenantUsersRepo = {
      find: vi.fn(),
    };
    const usersRepo = {
      update: vi.fn(),
    };
    const ctx: any = {
      action: {
        params: {
          values: {
            tenantId: 'tenant-b',
          },
        },
      },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'tenants') {
            return tenantsRepo;
          }
          if (name === 'tenantUsers') {
            return tenantUsersRepo;
          }
          if (name === 'users') {
            return usersRepo;
          }
          return {};
        }),
      },
      state: {
        currentUser: {
          id: 1,
          roles: ['root'],
        },
      },
      throw: vi.fn((status: number, message: string) => {
        const error: any = new Error(message);
        error.status = status;
        throw error;
      }),
    };

    await switchTenant(ctx, next);

    expect(tenantUsersRepo.find).not.toHaveBeenCalled();
    expect(usersRepo.update).toHaveBeenCalledWith({
      filterByTk: 1,
      values: {
        defaultTenantId: 'tenant-b',
      },
    });
    expect(ctx.state.currentTenantId).toBe('tenant-b');
    expect(ctx.body).toEqual({ id: 'tenant-b', title: 'Tenant B' });
    expect(next).toHaveBeenCalled();
  });
});
