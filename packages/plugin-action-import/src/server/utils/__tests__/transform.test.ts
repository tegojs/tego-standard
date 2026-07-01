import { describe, expect, it, vi } from 'vitest';

import { m2o } from '../transform';

describe('import transform relation helpers', () => {
  it('should throw when m2o enum label is missing', async () => {
    const findOne = vi.fn();
    const ctx = {
      db: {
        getRepository: vi.fn(() => ({ findOne })),
      },
    };

    await expect(
      m2o({
        value: 'Missing label',
        column: {
          dataIndex: ['category', 'name'],
          enum: [{ label: 'Known label', value: 'known-id' }],
        },
        field: {
          options: {
            target: 'categories',
          },
        },
        ctx,
      }),
    ).rejects.toThrow('not found enum value Missing label');

    expect(findOne).not.toHaveBeenCalled();
  });
});
