import { describe, expect, it, vi } from 'vitest';

import currentTenant from '../actions/current-tenant';

describe('currentTenant action', () => {
  it('should only expose public tenant fields', async () => {
    const next = vi.fn();
    const ctx: any = {
      state: {
        currentTenant: {
          id: 'tenant-a',
          name: 'tenant-a',
          title: 'Tenant A',
          enabled: true,
          path: '/tenant-a/',
          internalSecret: 'hidden',
        },
      },
    };

    await currentTenant(ctx, next);

    expect(ctx.body).toEqual({
      id: 'tenant-a',
      name: 'tenant-a',
      title: 'Tenant A',
    });
    expect(next).toHaveBeenCalled();
  });
});
