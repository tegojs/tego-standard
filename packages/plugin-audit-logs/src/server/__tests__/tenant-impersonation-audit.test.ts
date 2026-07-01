/**
 * Tenant impersonation audit trail tests.
 *
 * Verifies that when a root/platform admin impersonates a target tenant,
 * CRUD audit logs correctly record:
 *   - impersonatedTenantId
 *   - tenantContextSource
 *   - isTenantImpersonation = true
 *   - actorUserId / userId semantics (actual actor, not the impersonated tenant)
 *
 * Also verifies that normal tenant-member CRUD still produces
 * isTenantImpersonation = false.
 *
 * Covers: create / update / destroy operations.
 */
import { createMockServer, MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { auditLogsTestPlugin } from './helpers';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAuditLogs(db: Database, expected: number, timeoutMs = 5000): Promise<any[]> {
  const repo = db.getCollection('auditLogs').repository;
  const start = Date.now();
  let auditLogs: any[] = [];

  while (Date.now() - start < timeoutMs) {
    auditLogs = await repo.find({ appends: ['changes'] });
    if (auditLogs.length >= expected) {
      return auditLogs;
    }
    await sleep(50);
  }
  return auditLogs;
}

async function findAuditLog(db: Database, filter: Record<string, any>, timeoutMs = 5000): Promise<any | null> {
  const repo = db.getCollection('auditLogs').repository;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const log = await repo.findOne({ filter });
    if (log) return log;
    await sleep(50);
  }
  return null;
}

describe('tenant impersonation – CRUD audit fields', () => {
  let api: MockServer;
  let db: Database;
  let rootUser: any;

  beforeEach(async () => {
    api = await createMockServer({
      plugins: [auditLogsTestPlugin()],
    });
    db = api.db;

    db.collection({
      name: 'users',
      logging: false,
      fields: [
        { type: 'string', name: 'nickname' },
        { type: 'string', name: 'token' },
      ],
    });

    db.collection({
      name: 'audit_impersonation_posts',
      logging: true,
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'status', defaultValue: 'draft' },
      ],
    });
    await db.sync();

    const User = db.getCollection('users').model;
    rootUser = await User.create({ nickname: 'root_admin', token: 'root-token-impersonation' });
  });

  afterEach(async () => {
    await api.destroy();
  });

  /** Impersonation context simulating setCurrentTenant state for a root user */
  function impersonationContext() {
    return {
      state: {
        currentUser: rootUser,
        currentTenantId: 'tenant-target',
        actorUserId: rootUser.get('id'),
        impersonatedTenantId: 'tenant-target',
        tenantContextSource: 'platformImpersonation',
        isTenantImpersonation: true,
      },
    };
  }

  /** Normal member context (no impersonation) */
  function memberContext(tenantId = 'tenant-member') {
    return {
      state: {
        currentUser: rootUser,
        currentTenantId: tenantId,
        actorUserId: rootUser.get('id'),
        impersonatedTenantId: null,
        tenantContextSource: 'membership',
        isTenantImpersonation: false,
      },
    };
  }

  // ── 1. Impersonation create ──────────────────────────────────────────
  it('should record impersonation fields on create', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    await repo.create({
      values: { title: 'impersonated-create' },
      context: impersonationContext(),
    });

    const logs = await waitForAuditLogs(db, 1);
    expect(logs.length).toBe(1);

    const log = logs[0];
    expect(log.get('type')).toBe('create');
    expect(log.get('tenantId')).toBe('tenant-target');
    expect(log.get('impersonatedTenantId')).toBe('tenant-target');
    expect(log.get('tenantContextSource')).toBe('platformImpersonation');
    expect(log.get('isTenantImpersonation')).toBe(true);
  });

  // ── 2. Impersonation update ──────────────────────────────────────────
  it('should record impersonation fields on update', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    const created = await repo.create({
      values: { title: 'before-update' },
      context: impersonationContext(),
    });

    await repo.update({
      filterByTk: created.get('id'),
      values: { title: 'after-update' },
      context: impersonationContext(),
    });

    const logs = await waitForAuditLogs(db, 2);
    const updateLog = logs.find((l) => l.get('type') === 'update');
    expect(updateLog).toBeDefined();

    expect(updateLog.get('tenantId')).toBe('tenant-target');
    expect(updateLog.get('impersonatedTenantId')).toBe('tenant-target');
    expect(updateLog.get('tenantContextSource')).toBe('platformImpersonation');
    expect(updateLog.get('isTenantImpersonation')).toBe(true);
  });

  // ── 3. Impersonation destroy ─────────────────────────────────────────
  it('should record impersonation fields on destroy', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    const created = await repo.create({
      values: { title: 'doomed-record' },
      context: impersonationContext(),
    });

    await repo.destroy({
      filterByTk: created.get('id'),
      context: impersonationContext(),
    });

    const logs = await waitForAuditLogs(db, 2);
    const destroyLog = logs.find((l) => l.get('type') === 'destroy');
    expect(destroyLog).toBeDefined();

    expect(destroyLog.get('tenantId')).toBe('tenant-target');
    expect(destroyLog.get('impersonatedTenantId')).toBe('tenant-target');
    expect(destroyLog.get('tenantContextSource')).toBe('platformImpersonation');
    expect(destroyLog.get('isTenantImpersonation')).toBe(true);
  });

  // ── 4. Identity semantics ────────────────────────────────────────────
  it('should set userId and actorUserId to the actual actor, not the impersonated tenant', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    await repo.create({
      values: { title: 'identity-check' },
      context: impersonationContext(),
    });

    const logs = await waitForAuditLogs(db, 1);
    const log = logs[0];
    const actorId = rootUser.get('id');

    // actorUserId must be the root user, not the tenant (stored as string in DB)
    expect(log.get('actorUserId')).toBe(String(actorId));
    // userId must also be the root user (stored as integer via belongsTo)
    expect(log.get('userId')).toBe(actorId);
    // tenantId must be the impersonated tenant, not the user id
    expect(log.get('tenantId')).toBe('tenant-target');
    // tenantId must NOT equal the actor's user id
    expect(String(log.get('tenantId'))).not.toBe(String(actorId));
  });

  // ── 5. Normal member CRUD is NOT impersonation ───────────────────────
  it('should record isTenantImpersonation=false for normal tenant member CRUD', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    await repo.create({
      values: { title: 'member-create' },
      context: memberContext('tenant-member-a'),
    });

    const logs = await waitForAuditLogs(db, 1);
    const log = logs[0];

    expect(log.get('type')).toBe('create');
    expect(log.get('tenantId')).toBe('tenant-member-a');
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBe('membership');
    expect(log.get('actorUserId')).toBe(String(rootUser.get('id')));
  });

  it('should record isTenantImpersonation=false on update for normal member', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    const created = await repo.create({
      values: { title: 'member-before' },
      context: memberContext('tenant-member-b'),
    });

    await repo.update({
      filterByTk: created.get('id'),
      values: { title: 'member-after' },
      context: memberContext('tenant-member-b'),
    });

    const logs = await waitForAuditLogs(db, 2);
    const updateLog = logs.find((l) => l.get('type') === 'update');
    expect(updateLog).toBeDefined();
    expect(updateLog.get('isTenantImpersonation')).toBe(false);
    expect(updateLog.get('impersonatedTenantId')).toBeNull();
    expect(updateLog.get('tenantContextSource')).toBe('membership');
  });

  // ── 6. Impersonation + different business tenant ─────────────────────
  it('should distinguish impersonated tenant from actor tenant', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    // Actor belongs to tenant-actor but impersonates tenant-target
    const ctx = {
      state: {
        currentUser: rootUser,
        currentTenantId: 'tenant-target',
        actorUserId: rootUser.get('id'),
        impersonatedTenantId: 'tenant-target',
        tenantContextSource: 'platformImpersonation',
        isTenantImpersonation: true,
      },
    };

    await repo.create({
      values: { title: 'cross-tenant-impersonation' },
      context: ctx,
    });

    const logs = await waitForAuditLogs(db, 1);
    const log = logs[0];

    // tenantId records the operational tenant (target), not the actor's home tenant
    expect(log.get('tenantId')).toBe('tenant-target');
    // impersonatedTenantId matches the target
    expect(log.get('impersonatedTenantId')).toBe('tenant-target');
    // actorUserId is the root user — not a tenant ID
    expect(log.get('actorUserId')).toBe(String(rootUser.get('id')));
  });

  // ── 7. Missing impersonation fields → safe defaults ──────────────────
  it('should handle missing impersonation fields gracefully', async () => {
    const repo = db.getRepository('audit_impersonation_posts');
    // Minimal context — no impersonation-related state at all
    await repo.create({
      values: { title: 'no-impersonation-state' },
      context: {
        state: {
          currentUser: rootUser,
          currentTenantId: 'tenant-x',
        },
      },
    });

    const logs = await waitForAuditLogs(db, 1);
    const log = logs[0];

    expect(log.get('tenantId')).toBe('tenant-x');
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
  });
});

describe('tenant impersonation – security event audit trail', () => {
  let api: MockServer;
  let db: Database;

  beforeEach(async () => {
    api = await createMockServer({
      plugins: [auditLogsTestPlugin()],
    });
    db = api.db;

    // Re-register in case the plugin already registered it (idempotent)
    const { registerSecurityEventListener } = await import('../security-event-listener');
    registerSecurityEventListener({ app: api, db } as any);
  });

  afterEach(async () => {
    await api.destroy();
  });

  // ── 8. Security event: tenant_impersonation fields ───────────────────
  it('should write tenant_impersonation security event with all impersonation fields', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_impersonation',
      userId: 1,
      actorUserId: 1,
      tenantId: 'tenant-impersonated',
      action: 'current',
      collectionName: 'tenants',
      details: { impersonatedTenantId: 'tenant-impersonated', originalUserId: 1 },
    });

    const log = await findAuditLog(db, { type: 'tenant_impersonation' });
    expect(log).not.toBeNull();
    expect(log.get('isTenantImpersonation')).toBe(true);
    expect(log.get('impersonatedTenantId')).toBe('tenant-impersonated');
    expect(log.get('tenantContextSource')).toBe('platformImpersonation');
    expect(log.get('actorUserId')).toBe('1');
    expect(log.get('tenantId')).toBe('tenant-impersonated');
  });

  // ── 9. Security event: non-impersonation types ───────────────────────
  it('should mark tenant_cross_tenant_attempt as non-impersonation', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_cross_tenant_attempt',
      userId: 99,
      tenantId: 'tenant-illegal',
      action: 'list',
      collectionName: 'orders',
      details: { allowedTenantIds: ['tenant-a'], requestedTenantId: 'tenant-illegal' },
    });

    const log = await findAuditLog(db, { type: 'tenant_cross_tenant_attempt' });
    expect(log).not.toBeNull();
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
    expect(log.get('actorUserId')).toBe('99');
  });

  it('should mark tenant_access_denied as non-impersonation', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
      userId: 55,
      collectionName: 'secret_data',
      action: 'list',
    });

    const log = await findAuditLog(db, { type: 'tenant_access_denied' });
    expect(log).not.toBeNull();
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
  });

  it('should mark tenant_bulk_export_alert as non-impersonation', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_bulk_export_alert',
      userId: 77,
      actorUserId: 77,
      tenantId: 'tenant-export',
      collectionName: 'big_orders',
      action: 'export',
      details: { rowCount: 5000, threshold: 1000 },
    });

    const log = await findAuditLog(db, { type: 'tenant_bulk_export_alert' });
    expect(log).not.toBeNull();
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('actorUserId')).toBe('77');
    expect(log.get('tenantId')).toBe('tenant-export');
  });

  // ── 10. Impersonation event detail persistence ───────────────────────
  it('should persist original event details for impersonation events', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_impersonation',
      userId: 1,
      actorUserId: 1,
      tenantId: 'tenant-detail-check',
      action: 'current',
      collectionName: 'tenants',
      details: {
        impersonatedTenantId: 'tenant-detail-check',
        originalUserId: 1,
        source: 'X-Tenant-Id header',
      },
    });

    const log = await findAuditLog(db, { type: 'tenant_impersonation' });
    expect(log).not.toBeNull();

    const details = log.get('details');
    expect(details).toBeDefined();
    expect(details).not.toBeNull();
    expect(details.impersonatedTenantId).toBe('tenant-detail-check');
    expect(details.originalUserId).toBe(1);
    expect(details.source).toBe('X-Tenant-Id header');
  });
});

describe('tenant impersonation – audit context unit tests', () => {
  // Direct tests for getAuditContext() with impersonation state

  it('should extract impersonation fields from context state', async () => {
    const { getAuditContext } = await import('../hooks/audit-context');

    const ctx = getAuditContext({
      context: {
        state: {
          currentUser: { id: 42 },
          currentTenantId: 'tenant-ctx-test',
          actorUserId: 42,
          impersonatedTenantId: 'tenant-ctx-test',
          tenantContextSource: 'platformImpersonation',
          isTenantImpersonation: true,
        },
      },
    });

    expect(ctx.userId).toBe(42);
    expect(ctx.tenantId).toBe('tenant-ctx-test');
    expect(ctx.actorUserId).toBe(42);
    expect(ctx.impersonatedTenantId).toBe('tenant-ctx-test');
    expect(ctx.tenantContextSource).toBe('platformImpersonation');
    expect(ctx.isTenantImpersonation).toBe(true);
  });

  it('should fallback actorUserId to currentUser.id when state.actorUserId is absent', async () => {
    const { getAuditContext } = await import('../hooks/audit-context');

    const ctx = getAuditContext({
      context: {
        state: {
          currentUser: { id: 99 },
          currentTenantId: 'tenant-fallback',
          // actorUserId intentionally omitted
        },
      },
    });

    expect(ctx.actorUserId).toBe(99);
    expect(ctx.userId).toBe(99);
    expect(ctx.isTenantImpersonation).toBe(false);
    expect(ctx.impersonatedTenantId).toBeUndefined();
  });

  it('should handle completely empty state without throwing', async () => {
    const { getAuditContext } = await import('../hooks/audit-context');

    const ctx = getAuditContext({ context: { state: {} } });

    expect(ctx.userId).toBeUndefined();
    expect(ctx.actorUserId).toBeUndefined();
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.impersonatedTenantId).toBeUndefined();
    expect(ctx.tenantContextSource).toBeUndefined();
    expect(ctx.isTenantImpersonation).toBe(false);
  });

  it('should handle null options without throwing', async () => {
    const { getAuditContext } = await import('../hooks/audit-context');

    const ctx = getAuditContext(null);

    expect(ctx.userId).toBeUndefined();
    expect(ctx.isTenantImpersonation).toBe(false);
  });
});
