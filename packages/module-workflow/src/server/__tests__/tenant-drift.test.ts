/**
 * Tenant helper drift-prevention tests for module-workflow.
 *
 * Compares the local applyTenantFilterToContext (from helpers/tenant-context.ts)
 * against the authoritative implementation from @tachybase/module-tenant.
 * Covers all CRUD action types, both tenancy modes, legacy data, and value handling.
 * Also verifies runtime source does NOT import from module-tenant.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyTenantFilterToContext as authoritativeApply } from '@tachybase/module-tenant';

import { describe, expect, it } from 'vitest';

import { getDescendantTenantIds, applyTenantFilterToContext as localApply } from '../helpers/tenant-context';

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

// ---------------------------------------------------------------------------
// Shared scenarios covering all CRUD operations, tenancy modes, and edge cases
// ---------------------------------------------------------------------------

const SCENARIOS = [
  // --- tenantScoped ---
  {
    name: 'tenantScoped list',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    input: { filter: { status: 'published' } },
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped get',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'get',
    input: { filter: { id: 1 } },
    expectedFilter: { $and: [{ id: 1 }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped count',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'count',
    input: { filter: { active: true } },
    expectedFilter: { $and: [{ active: true }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped export',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'export',
    input: { filter: { status: 'published', tenantId: 'tenant-b' } },
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped aggregate',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'aggregate',
    input: { filter: { type: 'order' } },
    expectedFilter: { $and: [{ type: 'order' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped list with legacy data',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    input: { filter: { status: 'published' } },
    legacyDataTenantIds: ['tenant-a'],
    expectedFilter: {
      $and: [{ status: 'published' }, { $or: [{ tenantId: 'tenant-a' }, { tenantId: null }] }],
    },
  },

  // --- tenantInherited ---
  {
    name: 'tenantInherited list with descendants',
    tenancy: 'tenantInherited',
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1', 'child-2'] },
    actionName: 'list',
    input: { filter: { status: 'published' } },
    expectedFilter: {
      $and: [{ status: 'published' }, { tenantId: { $in: ['parent-a', 'child-1', 'child-2'] } }],
    },
  },
  {
    name: 'tenantInherited list with descendants and legacy data',
    tenancy: 'tenantInherited',
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1'] },
    actionName: 'list',
    input: { filter: { status: 'published' } },
    legacyDataTenantIds: ['parent-a'],
    expectedFilter: {
      $and: [{ status: 'published' }, { $or: [{ tenantId: { $in: ['parent-a', 'child-1'] } }, { tenantId: null }] }],
    },
  },
  {
    name: 'tenantInherited empty descendants',
    tenancy: 'tenantInherited',
    state: { currentTenantId: 'leaf-a', currentTenantDescendantIds: [] },
    actionName: 'list',
    input: { filter: {} },
    expectedFilter: { tenantId: { $in: ['leaf-a'] } },
  },

  // --- write actions (update / destroy) ---
  {
    name: 'tenantScoped update: scoped filter, no legacy data even if configured',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'update',
    input: { filter: { status: 'draft' }, values: { title: 'updated', tenantId: 'tenant-x' } },
    legacyDataTenantIds: ['tenant-a'],
    expectedFilter: { $and: [{ status: 'draft' }, { tenantId: 'tenant-a' }] },
    expectedValues: { title: 'updated' },
  },
  {
    name: 'tenantScoped destroy: scoped filter, no legacy data',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'destroy',
    input: { filter: { expired: true } },
    legacyDataTenantIds: ['tenant-a'],
    expectedFilter: { $and: [{ expired: true }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantInherited update: $in filter, strips tenantId from values',
    tenancy: 'tenantInherited',
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1'] },
    actionName: 'update',
    input: { filter: { status: 'draft' }, values: { title: 'updated', tenantId: 'child-1' } },
    expectedFilter: { $and: [{ status: 'draft' }, { tenantId: { $in: ['parent-a', 'child-1'] } }] },
    expectedValues: { title: 'updated' },
  },
  {
    name: 'tenantInherited destroy: $in filter',
    tenancy: 'tenantInherited',
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1'] },
    actionName: 'destroy',
    input: { filter: { expired: true } },
    expectedFilter: { $and: [{ expired: true }, { tenantId: { $in: ['parent-a', 'child-1'] } }] },
  },

  // --- create ---
  {
    name: 'tenantScoped create: injects tenantId into values',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'create',
    input: { values: { title: 'new post' } },
    expectedValues: { title: 'new post', tenantId: 'tenant-a' },
  },
  {
    name: 'tenantScoped create: array values each get tenantId',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'create',
    input: { values: [{ title: 'post 1' }, { title: 'post 2', tenantId: 'tenant-x' }] },
    expectedValues: [
      { title: 'post 1', tenantId: 'tenant-a' },
      { title: 'post 2', tenantId: 'tenant-a' },
    ],
  },
  {
    name: 'tenantInherited create: injects current tenantId (not descendant)',
    tenancy: 'tenantInherited',
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1'] },
    actionName: 'create',
    input: { values: { title: 'inherited post' } },
    expectedValues: { title: 'inherited post', tenantId: 'parent-a' },
  },

  // --- edge cases ---
  {
    name: 'empty filter produces tenant-only filter',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    input: { filter: {} },
    expectedFilter: { tenantId: 'tenant-a' },
  },
  {
    name: 'no filter produces tenant-only filter',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    input: {},
    expectedFilter: { tenantId: 'tenant-a' },
  },
  {
    name: 'legacy data NOT included for tenants not in legacyDataTenantIds',
    tenancy: 'tenantScoped',
    state: { currentTenantId: 'tenant-b' },
    actionName: 'list',
    input: { filter: { status: 'published' } },
    legacyDataTenantIds: ['tenant-a'],
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-b' }] },
  },
];

function buildCollection(scenario: (typeof SCENARIOS)[number]) {
  return {
    options: {
      tenancy: scenario.tenancy,
      ...(scenario.legacyDataTenantIds ? { legacyDataTenantIds: scenario.legacyDataTenantIds } : {}),
    },
  };
}

describe('workflow > tenant helper drift', () => {
  it('should not require module-tenant to load workflow runtime code', () => {
    for (const file of tenantAwareFiles) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      expect(source, file).not.toContain('@tachybase/module-tenant');
    }
  });

  describe.each(SCENARIOS)('$name', (scenario) => {
    it('local matches authoritative', () => {
      const collection = buildCollection(scenario);
      const context = { state: { ...scenario.state } };
      const input = JSON.parse(JSON.stringify(scenario.input));

      const localResult = localApply(context, collection, scenario.actionName, input);
      const authResult = authoritativeApply(context, collection, scenario.actionName, input);

      // Check filter
      if (scenario.expectedFilter !== undefined) {
        expect((localResult as any).filter).toEqual(scenario.expectedFilter);
        expect((authResult as any).filter).toEqual(scenario.expectedFilter);
        expect((localResult as any).filter).toEqual((authResult as any).filter);
      }

      // Check values (create / update)
      if (scenario.expectedValues !== undefined) {
        expect((localResult as any).values).toEqual(scenario.expectedValues);
        expect((authResult as any).values).toEqual(scenario.expectedValues);
        expect((localResult as any).values).toEqual((authResult as any).values);
      }

      // Critical: local and authoritative must be structurally identical
      expect(localResult).toEqual(authResult);
    });
  });

  it('both implementations are no-op without tenant context', () => {
    const options = { filter: { title: 'same' } };
    const collection = { options: { tenancy: 'tenantScoped' } };

    const localResult = localApply({ state: {} }, collection, 'list', options);
    const authResult = authoritativeApply({ state: {} }, collection, 'list', options);

    expect(localResult).toBe(options);
    expect(authResult).toBe(options);
  });

  it('both implementations are no-op for non-tenant collections', () => {
    const options = { filter: { title: 'shared' } };
    const context = { state: { currentTenantId: 'tenant-a' } };

    const localResult = localApply(context, { options: { tenancy: 'shared' } }, 'list', options);
    const authResult = authoritativeApply(context, { options: { tenancy: 'shared' } }, 'list', options);

    expect(localResult).toBe(options);
    expect(authResult).toBe(options);
  });

  it('getDescendantTenantIds is exported as async function', () => {
    expect(typeof getDescendantTenantIds).toBe('function');
    // Verify it returns a promise when called
    const result = getDescendantTenantIds(null, 'any-tenant');
    expect(result).toBeInstanceOf(Promise);
  });
});
