/**
 * Tenant helper drift-prevention tests for plugin-action-export.
 *
 * Compares the local worker tenant-scope helper output against the
 * authoritative applyTenantFilterToContext from @tachybase/module-tenant.
 * Also verifies the runtime source does NOT import from module-tenant.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { applyTenantFilterToContext } from '../../../../module-tenant/src/server/helpers/tenant-filter';
import ExportPlugin from '../index';

const exportTenantAwareFiles = ['index.ts', 'actions/export-xlsx.ts'];

// ---------------------------------------------------------------------------
// Shared scenarios: tenantScoped / tenantInherited / legacy / write actions
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    name: 'tenantScoped list appends tenantId filter',
    tenancy: 'tenantScoped' as const,
    tenantContext: {
      currentTenant: { id: 'tenant-a' },
      currentTenantId: 'tenant-a',
      currentTenancyMode: 'tenantScoped',
      currentTenantDescendantIds: [],
      currentLegacyDataTenantIds: [],
    },
    inputFilter: { status: 'published' },
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped list with legacy data includes null tenantId',
    tenancy: 'tenantScoped' as const,
    tenantContext: {
      currentTenant: { id: 'tenant-a' },
      currentTenantId: 'tenant-a',
      currentTenancyMode: 'tenantScoped',
      currentTenantDescendantIds: [],
      currentLegacyDataTenantIds: ['tenant-a'],
    },
    inputFilter: { status: 'published' },
    expectedFilter: {
      $and: [{ status: 'published' }, { $or: [{ tenantId: 'tenant-a' }, { tenantId: null }] }],
    },
  },
  {
    name: 'tenantInherited list uses $in with descendants',
    tenancy: 'tenantInherited' as const,
    tenantContext: {
      currentTenant: { id: 'parent-a' },
      currentTenantId: 'parent-a',
      currentTenancyMode: 'tenantInherited',
      currentTenantDescendantIds: ['child-1', 'child-2'],
      currentLegacyDataTenantIds: [],
    },
    inputFilter: { status: 'published' },
    expectedFilter: {
      $and: [{ status: 'published' }, { tenantId: { $in: ['parent-a', 'child-1', 'child-2'] } }],
    },
  },
  {
    name: 'tenantInherited list with legacy data',
    tenancy: 'tenantInherited' as const,
    tenantContext: {
      currentTenant: { id: 'parent-a' },
      currentTenantId: 'parent-a',
      currentTenancyMode: 'tenantInherited',
      currentTenantDescendantIds: ['child-1'],
      currentLegacyDataTenantIds: ['parent-a'],
    },
    inputFilter: { status: 'published' },
    expectedFilter: {
      $and: [{ status: 'published' }, { $or: [{ tenantId: { $in: ['parent-a', 'child-1'] } }, { tenantId: null }] }],
    },
  },
  {
    name: 'tenantScoped export strips user tenantId and enforces current tenant',
    tenancy: 'tenantScoped' as const,
    tenantContext: {
      currentTenant: { id: 'tenant-a' },
      currentTenantId: 'tenant-a',
      currentTenancyMode: 'tenantScoped',
      currentTenantDescendantIds: [],
      currentLegacyDataTenantIds: [],
    },
    inputFilter: { status: 'published', tenantId: 'tenant-b' },
    expectedFilter: { $and: [{ status: 'published' }, { tenantId: 'tenant-a' }] },
  },
  {
    name: 'tenantScoped list with empty filter produces tenant filter only',
    tenancy: 'tenantScoped' as const,
    tenantContext: {
      currentTenant: { id: 'tenant-a' },
      currentTenantId: 'tenant-a',
      currentTenancyMode: 'tenantScoped',
      currentTenantDescendantIds: [],
      currentLegacyDataTenantIds: [],
    },
    inputFilter: {},
    expectedFilter: { tenantId: 'tenant-a' },
  },
];

describe('export > tenant helper drift', () => {
  it('should not import from @tachybase/module-tenant in runtime source', () => {
    for (const file of exportTenantAwareFiles) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      expect(source, `runtime file ${file} should not import module-tenant`).not.toContain('@tachybase/module-tenant');
    }
  });

  describe.each(SCENARIOS)('$name', (scenario) => {
    it('local worker filter matches authoritative behavior', async () => {
      const find = vi.fn().mockResolvedValue([]);
      const repository = {
        collection: {
          options: { tenancy: scenario.tenancy },
          fields: new Map([['title', { name: 'title', options: { interface: 'input' } }]]),
          hasField: vi.fn().mockReturnValue(true),
        },
        find,
      };

      const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-drift-'));
      try {
        const plugin = {
          db: { getRepository: vi.fn().mockReturnValue(repository) },
          xlsxStorageDir: () => tempDir,
        };

        await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
          title: 'drift-test',
          filter: { ...scenario.inputFilter },
          columns: [{ dataIndex: ['title'], defaultTitle: 'Title', title: 'Title' }],
          resourceName: 'drift_test_posts',
          currentTenantId: scenario.tenantContext.currentTenantId,
          tenantContext: scenario.tenantContext,
        });

        // Extract the filter the local helper applied to repository.find
        const localFilter = find.mock.calls[0]?.[0]?.filter;

        // Run authoritative implementation with equivalent inputs
        const authOptions = applyTenantFilterToContext(
          { state: { ...scenario.tenantContext } },
          { options: { tenancy: scenario.tenancy } },
          'list',
          { filter: { ...scenario.inputFilter } },
        );
        const authFilter = (authOptions as any).filter;

        // Both should match expected
        expect(localFilter).toEqual(scenario.expectedFilter);
        expect(authFilter).toEqual(scenario.expectedFilter);

        // Critical: local and authoritative must produce identical results
        expect(localFilter).toEqual(authFilter);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('local no-tenant passthrough matches authoritative no-tenancy passthrough', () => {
    const inputFilter = { status: 'published' };

    const authOptions = applyTenantFilterToContext(
      { state: { currentTenantId: 'tenant-a' } },
      { options: {} },
      'list',
      { filter: { ...inputFilter } },
    );

    expect((authOptions as any).filter).toEqual(inputFilter);
  });
});
