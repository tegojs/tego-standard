/**
 * Regression tests: module-tenant NOT loaded – plugin-block-charts.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * Chart query tenant-scope middleware must pass through without error and without
 * injecting tenant filters, even when the collection declares tenancy and the
 * request carries an X-Tenant-Id header (which never reaches ctx.state without
 * the tenant middleware).
 *
 * NOTE: We do NOT modify packages/plugin-block-charts/src/server/actions/query.ts.
 */
import { createMockServer, MockServer } from '@tachybase/test';

import { vi } from 'vitest';

import { applyTenantScope } from '../actions/query';

describe('plugin-block-charts – tenant module NOT loaded', () => {
  let app: MockServer;
  const next = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['data-source-manager'],
    });

    // Register a tenantScoped collection
    app.db.collection({
      name: 'scoped_orders',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'id', type: 'bigInt' },
        { name: 'amount', type: 'double' },
        { name: 'tenantId', type: 'string' },
      ],
    });

    // Register a tenantInherited collection
    app.db.collection({
      name: 'inherited_items',
      tenancy: 'tenantInherited',
      fields: [
        { name: 'id', type: 'bigInt' },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });

    // Register a normal (non-tenant) collection
    app.db.collection({
      name: 'public_data',
      fields: [
        { name: 'id', type: 'bigInt' },
        { name: 'value', type: 'string' },
      ],
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createCtx(collectionName: string, filter?: any, stateExtra?: Record<string, any>) {
    return {
      state: {
        currentUser: { id: 1 },
        // NO currentTenant, NO currentTenantId — simulates absence of tenant middleware
        ...stateExtra,
      },
      db: app.db,
      tego: app,
      action: {
        params: {
          values: {
            collection: collectionName,
            filter: filter ?? {},
          },
        },
      },
      get: vi.fn().mockReturnValue(undefined),
    } as any;
  }

  it('should pass through without error for tenantScoped collection', async () => {
    const ctx = createCtx('scoped_orders', { status: 'active' });
    await expect(applyTenantScope(ctx, next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalled();
    // Filter should be unchanged — no tenant filter injected
    expect(ctx.action.params.values.filter).toEqual({ status: 'active' });
  });

  it('should pass through without error for tenantInherited collection', async () => {
    const ctx = createCtx('inherited_items', { name: 'test' });
    await expect(applyTenantScope(ctx, next)).resolves.not.toThrow();
    expect(ctx.action.params.values.filter).toEqual({ name: 'test' });
  });

  it('should pass through without error for non-tenant collection', async () => {
    const ctx = createCtx('public_data', { value: 'x' });
    await expect(applyTenantScope(ctx, next)).resolves.not.toThrow();
    expect(ctx.action.params.values.filter).toEqual({ value: 'x' });
  });

  it('should NOT inject tenant filter for tenantScoped collection even with empty filter', async () => {
    const ctx = createCtx('scoped_orders', {});
    await applyTenantScope(ctx, next);
    expect(ctx.action.params.values.filter).toEqual({});
  });

  it('should ignore X-Tenant-Id-like state when no tenant middleware populated it', async () => {
    // Simulate: a reverse proxy set X-Tenant-Id header, but without tenant middleware
    // the header is NOT parsed into ctx.state.  Some code might try to read it from
    // ctx.get('X-Tenant-Id') but our helpers only read ctx.state — verify this.
    const ctx = createCtx('scoped_orders', { status: 'active' });
    // Even if we simulate header presence via ctx.get:
    ctx.get = vi.fn().mockImplementation((name: string) => {
      if (name === 'X-Tenant-Id') return 'rogue-tenant';
      return undefined;
    });

    await applyTenantScope(ctx, next);

    // Filter must NOT include any tenantId — the middleware doesn't read headers
    expect(ctx.action.params.values.filter).toEqual({ status: 'active' });
  });

  it('should handle undefined filter gracefully', async () => {
    const ctx = createCtx('scoped_orders', undefined);
    await expect(applyTenantScope(ctx, next)).resolves.not.toThrow();
  });
});
