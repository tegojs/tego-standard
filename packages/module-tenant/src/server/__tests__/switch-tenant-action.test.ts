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
});
