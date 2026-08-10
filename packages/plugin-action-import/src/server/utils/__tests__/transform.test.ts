import { describe, expect, it, vi } from 'vitest';

import { m2m, m2o, o2m, o2o } from '../transform';

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

  it('should trim m2o values before querying non-enum relation fields', async () => {
    const relatedRecord = { id: 1 };
    const findOne = vi.fn().mockResolvedValue(relatedRecord);
    const ctx = {
      db: {
        getRepository: vi.fn(() => ({ findOne })),
      },
    };

    const result = await m2o({
      value: '  Category A  ',
      column: {
        dataIndex: ['category', 'name'],
      },
      field: {
        options: {
          target: 'categories',
        },
      },
      ctx,
    });

    expect(result).toBe(relatedRecord);
    expect(findOne).toHaveBeenCalledWith({
      filter: { name: 'Category A' },
      context: ctx,
    });
  });

  it.each([
    ['o2o', o2o, 'findOne', 'Category A'],
    ['o2m', o2m, 'find', 'Category A; Category B'],
    ['m2o', m2o, 'findOne', 'Category A'],
    ['m2m', m2m, 'find', 'Category A; Category B'],
  ])('should scope %s relation lookups to the current tenant', async (_name, transform, method, value) => {
    const findOne = vi.fn().mockResolvedValue({ id: 1, tenantId: 'tenant-a' });
    const find = vi.fn().mockResolvedValue([{ id: 1, tenantId: 'tenant-a' }]);
    const repository = { findOne, find };
    const ctx: any = {
      state: { currentTenantId: 'tenant-a' },
      db: {
        getRepository: vi.fn(() => repository),
        getCollection: vi.fn(() => ({ options: { tenancy: 'tenantScoped' } })),
      },
    };

    await transform({
      value,
      column: { dataIndex: ['category', 'name'] },
      field: { options: { target: 'categories' } },
      ctx,
    });

    const query = method === 'findOne' ? findOne : find;
    expect(query).toHaveBeenCalledWith({
      filter: {
        $and: [{ name: method === 'findOne' ? 'Category A' : ['Category A', 'Category B'] }, { tenantId: 'tenant-a' }],
      },
      context: ctx,
    });
  });

  it('rejects tenant-aware relation lookups without context when the tenant plugin is enabled', async () => {
    const findOne = vi.fn();
    const ctx: any = {
      state: {},
      tego: {
        pm: {
          get: vi.fn().mockReturnValue({ enabled: true }),
        },
      },
      db: {
        getRepository: vi.fn(() => ({ findOne })),
        getCollection: vi.fn(() => ({ options: { tenancy: 'tenantScoped' } })),
      },
      throw(status: number, message: string) {
        const error: any = new Error(message);
        error.status = status;
        throw error;
      },
    };

    await expect(
      m2o({
        value: 'Category A',
        column: { dataIndex: ['category', 'name'] },
        field: { options: { target: 'categories' } },
        ctx,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(findOne).not.toHaveBeenCalled();
  });
});
