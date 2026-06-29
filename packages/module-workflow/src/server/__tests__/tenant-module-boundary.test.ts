import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyTenantFilterToContext } from '../helpers/tenant-context';

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
});
