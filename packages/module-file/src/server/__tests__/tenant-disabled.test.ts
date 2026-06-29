/**
 * Regression tests: module-tenant NOT loaded – module-file helpers.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * File storage helpers must degrade gracefully: no tenant subdirectory, no tenantId
 * injection into attachment records.
 */
import { describe, expect, it } from 'vitest';

import { getCurrentTenantId, getTenantStoragePath } from '../utils';

// ---------------------------------------------------------------------------
// getCurrentTenantId – no tenant state
// ---------------------------------------------------------------------------

describe('module-file helpers – tenant module NOT loaded', () => {
  describe('getCurrentTenantId', () => {
    it('returns undefined when ctx.state is empty', () => {
      expect(getCurrentTenantId({ state: {} })).toBeUndefined();
    });

    it('returns undefined when ctx.state has no tenant fields', () => {
      expect(getCurrentTenantId({ state: { currentUser: { id: 1 } } })).toBeUndefined();
    });

    it('returns undefined for null/undefined ctx', () => {
      expect(getCurrentTenantId(null)).toBeUndefined();
      expect(getCurrentTenantId(undefined)).toBeUndefined();
    });

    it('returns undefined when ctx has no state property', () => {
      expect(getCurrentTenantId({})).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getTenantStoragePath – no tenantId
  // ---------------------------------------------------------------------------

  describe('getTenantStoragePath', () => {
    it('returns base storagePath unchanged when tenantId is undefined', () => {
      expect(getTenantStoragePath('storage/uploads')).toBe('storage/uploads');
    });

    it('returns base storagePath unchanged when tenantId is empty string', () => {
      expect(getTenantStoragePath('storage/uploads', '')).toBe('storage/uploads');
    });

    it('returns empty string when storagePath is empty and no tenantId', () => {
      expect(getTenantStoragePath('', undefined)).toBe('');
    });

    it('normalizes leading/trailing slashes on base path', () => {
      expect(getTenantStoragePath('/storage/uploads/')).toBe('storage/uploads');
    });

    it('does NOT contain tenants/ segment when tenantId is absent', () => {
      const path = getTenantStoragePath('storage/uploads', undefined);
      expect(path).not.toContain('tenants');
    });

    it('returns default empty path when storagePath is undefined', () => {
      expect(getTenantStoragePath(undefined, undefined)).toBe('');
    });

    it('uses forward slashes (POSIX) on Windows-style paths', () => {
      const result = getTenantStoragePath('storage\\uploads', undefined);
      expect(result).not.toContain('\\');
    });
  });
});
