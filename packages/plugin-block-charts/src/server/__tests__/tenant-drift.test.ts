/**
 * Tenant helper drift-prevention tests for plugin-block-charts.
 *
 * Compares the local chart query tenant-scope middleware output against the
 * authoritative applyTenantFilterToContext from @tachybase/module-tenant.
 * Also verifies the runtime source does NOT import from module-tenant.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyTenantFilterToContext } from '@tachybase/module-tenant';

import { describe, expect, it, vi } from 'vitest';

import { applyTenantScope } from '../actions/query';

const chartTenantAwareFiles = ['actions/query.ts'];

// ---------------------------------------------------------------------------
// Shared scenarios: tenantScoped / tenantInherited / legacy / write actions
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    name: 'tenantScoped list appends tenantId filter',
    tenancy: 'tenantScoped' as const,
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    inputFilter: { status: 'published' },
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped list with legacy data includes null tenantId',
    tenancy: 'tenantScoped' as const,
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    inputFilter: { status: 'published' },
    legacyDataTenantIds: ['tenant-a'],
    expectedFilter: {
      $and: [{ status: 'published' }, { $or: [{ tenantId: 'tenant-a' }, { tenantId: null }] }],
    },
  },
  {
    name: 'tenantInherited list uses $in with descendants',
    tenancy: 'tenantInherited' as const,
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1', 'child-2'] },
    actionName: 'list',
    inputFilter: { status: 'published' },
    expectedFilter: {
      $and: [{ status: 'published' }, { tenantId: { $in: ['parent-a', 'child-1', 'child-2'] } }],
    },
  },
  {
    name: 'tenantInherited list with legacy data',
    tenancy: 'tenantInherited' as const,
    state: { currentTenantId: 'parent-a', currentTenantDescendantIds: ['child-1'] },
    actionName: 'list',
    inputFilter: { status: 'published' },
    legacyDataTenantIds: ['parent-a'],
    expectedFilter: {
      $and: [{ status: 'published' }, { $or: [{ tenantId: { $in: ['parent-a', 'child-1'] } }, { tenantId: null }] }],
    },
  },
  {
    name: 'tenantScoped export strips user tenantId and enforces current tenant',
    tenancy: 'tenantScoped' as const,
    state: { currentTenantId: 'tenant-a' },
    actionName: 'export',
    inputFilter: { status: 'published', tenantId: 'tenant-b' },
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped list with empty filter produces tenant filter only',
    tenancy: 'tenantScoped' as const,
    state: { currentTenantId: 'tenant-a' },
    actionName: 'list',
    inputFilter: {},
    expectedFilter: { tenantId: 'tenant-a' },
  },
];

describe('charts > tenant helper drift', () => {
  it('should not import from @tachybase/module-tenant in runtime source', () => {
    for (const file of chartTenantAwareFiles) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      expect(source, `runtime file ${file} should not import module-tenant`).not.toContain('@tachybase/module-tenant');
    }
  });

  describe.each(SCENARIOS)('$name', (scenario) => {
    it('local applyTenantScope matches authoritative behavior', async () => {
      const collectionName = 'drift_test_collection';
      const mockCollection = {
        options: {
          tenancy: scenario.tenancy,
          ...(scenario.legacyDataTenantIds ? { legacyDataTenantIds: scenario.legacyDataTenantIds } : {}),
        },
      };

      // Run local chart middleware
      const ctx: any = {
        state: { ...scenario.state },
        db: {
          getCollection: vi.fn().mockReturnValue(mockCollection),
        },
        action: {
          params: {
            values: {
              collection: collectionName,
              filter: { ...scenario.inputFilter },
            },
          },
        },
      };
      await applyTenantScope(ctx, async () => {});
      const localFilter = ctx.action.params.values.filter;

      // Run authoritative implementation with equivalent inputs
      const authOptions = applyTenantFilterToContext(
        { state: { ...scenario.state } },
        {
          options: {
            tenancy: scenario.tenancy,
            ...(scenario.legacyDataTenantIds ? { legacyDataTenantIds: scenario.legacyDataTenantIds } : {}),
          },
        },
        scenario.actionName,
        { filter: { ...scenario.inputFilter } },
      );
      const authFilter = (authOptions as any).filter;

      // Both should match expected
      expect(localFilter).toEqual(scenario.expectedFilter);
      expect(authFilter).toEqual(scenario.expectedFilter);

      // Critical: local and authoritative must produce identical results
      expect(localFilter).toEqual(authFilter);
    });
  });

  it('applyTenantScope is a no-op for non-tenant collections', async () => {
    const inputFilter = { status: 'published' };
    const ctx: any = {
      state: { currentTenantId: 'tenant-a' },
      db: {
        getCollection: vi.fn().mockReturnValue({ options: {} }),
      },
      action: {
        params: {
          values: {
            collection: 'shared_collection',
            filter: { ...inputFilter },
          },
        },
      },
    };
    await applyTenantScope(ctx, async () => {});
    expect(ctx.action.params.values.filter).toEqual(inputFilter);

    // Authoritative should also be a no-op
    const authOptions = applyTenantFilterToContext(
      { state: { currentTenantId: 'tenant-a' } },
      { options: { tenancy: 'shared' } },
      'list',
      { filter: { ...inputFilter } },
    );
    expect((authOptions as any).filter).toEqual(inputFilter);
  });
});
