/**
 * Regression tests: module-tenant NOT loaded – plugin-workflow-approval.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * Approval workflow helpers must degrade gracefully:
 * - getCurrentTenantId returns undefined
 * - withCurrentTenantFilter returns the original filter unchanged
 * - getTenantValuesFromExecution returns empty object
 * - getTenantWorkflowOptionsFromApproval returns empty object
 */
import { describe, expect, it } from 'vitest';

import {
  getCurrentTenantId,
  getTenantValuesFromExecution,
  getTenantWorkflowOptionsFromApproval,
  withCurrentTenantFilter,
} from '../helpers/tenant-filter';

describe('workflow approval helpers – tenant module NOT loaded', () => {
  describe('getCurrentTenantId', () => {
    it('returns undefined when ctx.state is empty', () => {
      expect(getCurrentTenantId({ state: {} })).toBeUndefined();
    });

    it('returns undefined when ctx is null', () => {
      expect(getCurrentTenantId(null)).toBeUndefined();
    });

    it('returns undefined when ctx is undefined', () => {
      expect(getCurrentTenantId(undefined)).toBeUndefined();
    });

    it('returns undefined when ctx has no state', () => {
      expect(getCurrentTenantId({})).toBeUndefined();
    });

    it('returns undefined when ctx.state only has currentUser', () => {
      expect(getCurrentTenantId({ state: { currentUser: { id: 1 } } })).toBeUndefined();
    });
  });

  describe('withCurrentTenantFilter', () => {
    it('returns original filter when tenant context is absent', () => {
      const filter = { status: 'active' };
      expect(withCurrentTenantFilter({ state: {} }, filter)).toEqual(filter);
    });

    it('returns original filter when ctx has no state', () => {
      const filter = { status: 'active' };
      expect(withCurrentTenantFilter({}, filter)).toEqual(filter);
    });

    it('returns empty filter as-is when no tenant context', () => {
      expect(withCurrentTenantFilter({ state: {} }, {})).toEqual({});
    });

    it('returns default empty filter when undefined filter is passed and no tenant context', () => {
      // withCurrentTenantFilter has default param `filter: any = {}`,
      // so passing undefined yields {} (the default), not undefined.
      expect(withCurrentTenantFilter({ state: {} }, undefined)).toEqual({});
    });

    it('does NOT inject tenantId into filter without tenant context', () => {
      const filter = { name: 'test', type: 'approval' };
      const result = withCurrentTenantFilter({ state: {} }, filter);
      expect(result).toEqual(filter);
      const filterStr = JSON.stringify(result);
      expect(filterStr).not.toContain('tenantId');
    });

    it('does NOT strip tenantId from filter when no tenant context (pass-through)', () => {
      // When tenant module is NOT loaded, the filter should pass through
      // unchanged — including any tenantId a caller may have added.
      // Only when the tenant module IS active does withCurrentTenantFilter
      // strip and reapply.
      const filter = { status: 'active', tenantId: 'manual-value' };
      const result = withCurrentTenantFilter({ state: {} }, filter);
      // Without tenant context, the function returns the filter as-is
      expect(result).toEqual(filter);
    });
  });

  describe('getTenantValuesFromExecution', () => {
    it('returns empty object when execution has no tenantId', () => {
      const execution = { get: () => undefined };
      expect(getTenantValuesFromExecution(execution)).toEqual({});
    });

    it('returns empty object when execution is null', () => {
      expect(getTenantValuesFromExecution(null)).toEqual({});
    });

    it('returns empty object when execution is undefined', () => {
      expect(getTenantValuesFromExecution(undefined)).toEqual({});
    });

    it('returns empty object for execution without get method', () => {
      expect(getTenantValuesFromExecution({})).toEqual({});
    });
  });

  describe('getTenantWorkflowOptionsFromApproval', () => {
    it('returns empty object when approval has no tenantId', () => {
      const approval = { get: () => undefined };
      expect(getTenantWorkflowOptionsFromApproval(approval)).toEqual({});
    });

    it('returns empty object when approval is null', () => {
      expect(getTenantWorkflowOptionsFromApproval(null)).toEqual({});
    });

    it('returns empty object when approval is undefined', () => {
      expect(getTenantWorkflowOptionsFromApproval(undefined)).toEqual({});
    });

    it('returns empty object for approval without get method', () => {
      expect(getTenantWorkflowOptionsFromApproval({})).toEqual({});
    });
  });
});
