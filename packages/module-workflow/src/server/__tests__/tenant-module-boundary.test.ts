import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { applyTenantFilterToContext, getDescendantTenantIds } from '../helpers/tenant-context';

const tenantAwareFiles = [
  'instructions/QueryInstruction.ts',
  'instructions/SelectInstruction.ts',
  'instructions/UpdateInstruction.ts',
  'instructions/UpdateOrCreateInstruction.ts',
  'instructions/DestroyInstruction.ts',
  'features/aggregate/AggregateInstruction.ts',
  'triggers/ScheduleTrigger/DateFieldScheduleTrigger.ts',
  'helpers/tenant-context.ts',
];

describe('workflow > tenant module boundary', () => {
  it('should not require module-tenant to load workflow runtime code', () => {
    for (const file of tenantAwareFiles) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');

      expect(source, file).not.toContain('@tachybase/module-tenant');
    }
  });

  it('should not apply tenant filters without a tenant context', () => {
    const options = {
      filter: {
        title: 'same-title',
      },
    };

    expect(
      applyTenantFilterToContext(
        { state: {} },
        {
          options: {
            tenancy: 'tenantScoped',
          },
        },
        'list',
        options,
      ),
    ).toBe(options);
  });

  it('should treat numeric zero as a valid tenant context value', () => {
    const options = {
      filter: {
        title: 'same-title',
      },
    };

    expect(
      applyTenantFilterToContext(
        {
          state: {
            currentTenantId: 0,
          },
        },
        {
          options: {
            tenancy: 'tenantScoped',
          },
        },
        'list',
        options,
      ),
    ).toEqual({
      filter: {
        $and: [
          {
            title: 'same-title',
          },
          {
            tenantId: 0,
          },
        ],
      },
    });
  });

  it('should resolve descendants without treating underscore as a path wildcard', async () => {
    const findOne = vi.fn(async () => ({
      get: (key: string) => (key === 'path' ? '/root_1/' : undefined),
    }));
    const find = vi.fn(async () => [
      { get: (key: string) => (key === 'id' ? 'root_1_child' : key === 'path' ? '/root_1/root_1_child/' : undefined) },
      { get: (key: string) => (key === 'id' ? 'root-a-child' : key === 'path' ? '/root-a/root-a-child/' : undefined) },
    ]);
    const db = {
      getRepository: vi.fn(() => ({ findOne, find })),
    };

    await expect(getDescendantTenantIds(db, 'root_1')).resolves.toEqual(['root_1_child']);
    expect(find).toHaveBeenCalledWith({
      fields: ['id', 'path'],
    });
  });
});
