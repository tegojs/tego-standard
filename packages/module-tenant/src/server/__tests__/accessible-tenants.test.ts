import { describe, expect, it, vi } from 'vitest';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';

describe('getAccessibleTenantIds', () => {
  it('should constrain descendant lookup by tenant path prefixes in the repository query', async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce([
        {
          get: (key: string) => ({ id: 'hq', path: '/hq/' })[key],
        },
      ])
      .mockResolvedValueOnce([
        {
          get: (key: string) => ({ id: 'branch', path: '/hq/branch/' })[key],
        },
      ]);
    const db: any = {
      getRepository: vi.fn(() => ({ find })),
    };

    const ids = await getAccessibleTenantIds(db, ['hq']);

    expect(ids).toEqual(['hq', 'branch']);
    expect(find).toHaveBeenNthCalledWith(2, {
      filter: {
        $or: [
          {
            path: {
              $gte: '/hq/',
              $lt: `/hq/\uffff`,
            },
            'id.$ne': 'hq',
          },
        ],
        enabled: true,
      },
      fields: ['id', 'path'],
      transaction: undefined,
    });
  });
});
