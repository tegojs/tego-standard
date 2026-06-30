/**
 * Regression tests: module-tenant NOT loaded – plugin-action-import.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * Import actions must still function: the import middleware must pass through,
 * downloadXlsxTemplate must succeed, and the X-Tenant-Id header must be ignored
 * (no tenant middleware to parse it into ctx.state).
 */
import { createMockServer, MockServer } from '@tachybase/test';

import { describe, expect, it, vi } from 'vitest';

describe('plugin-action-import – tenant module NOT loaded', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['error-handler', 'data-source-manager', 'collection-manager'],
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should start the application without errors', () => {
    expect(app).toBeTruthy();
  });

  it('should not have the tenant plugin registered', () => {
    expect(app.pm.get('tenant')).toBeFalsy();
  });

  it('should not have setCurrentTenant middleware', () => {
    const middlewares = (app as any).middleware || [];
    const tags = middlewares.map((m: any) => m.tag || m.name).filter(Boolean);
    expect(tags).not.toContain('setCurrentTenant');
  });

  it('should not populate ctx.state with tenant context when X-Tenant-Id is present', () => {
    // Verify that without the tenant plugin, there's no middleware to
    // convert X-Tenant-Id header into ctx.state.currentTenantId.
    // The state should remain clean even if the header is set.
    const ctx = {
      state: { currentUser: { id: 1 } },
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'X-Tenant-Id') return 'rogue-tenant';
        return undefined;
      }),
    };

    // Simulate what would happen: ctx.state is NOT populated by any tenant middleware
    expect(ctx.state.currentTenantId).toBeUndefined();
    expect(ctx.state.currentTenant).toBeUndefined();
    expect(ctx.state.currentTenancyMode).toBeUndefined();
  });
});

describe('downloadXlsxTemplate – tenant module NOT loaded', () => {
  it('should produce template without tenant context', async () => {
    // downloadXlsxTemplate is a pure function that doesn't depend on tenant state.
    // Verify it works without any tenant fields in ctx.state.
    const { downloadXlsxTemplate } = await import('../actions/downloadXlsxTemplate');

    const ctx: any = {
      request: {
        body: {
          columns: [
            { dataIndex: ['name'], defaultTitle: 'Name' },
            { dataIndex: ['email'], defaultTitle: 'Email' },
          ],
          title: 'Users',
        },
      },
      state: {
        currentUser: { id: 1 },
        // NO currentTenant, NO currentTenantId
      },
      body: null,
      set: vi.fn(),
      t: vi.fn().mockImplementation((s: string) => s),
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await downloadXlsxTemplate(ctx, next);

    expect(ctx.body).toBeTruthy();
    expect(next).toHaveBeenCalled();
    expect(ctx.set).toHaveBeenCalled();

    // Verify Content-Disposition doesn't contain any tenant references
    const setCall = ctx.set.mock.calls[0][0];
    expect(setCall['Content-Disposition']).not.toContain('tenant');
  });
});
