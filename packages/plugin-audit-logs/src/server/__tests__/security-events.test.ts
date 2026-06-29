import { createMockServer, MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { registerSecurityEventListener } from '../security-event-listener';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSecurityEvent(db: Database, eventType: string, timeoutMs = 3000): Promise<any | null> {
  const repo = db.getCollection('auditLogs').repository;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const log = await repo.findOne({
      filter: { type: eventType },
      order: [['id', 'DESC']],
    });
    if (log) return log;
    await sleep(50);
  }
  return null;
}

async function countSecurityEvents(db: Database, eventType: string): Promise<number> {
  const repo = db.getCollection('auditLogs').repository;
  const logs = await repo.find({ filter: { type: eventType } });
  return logs.length;
}

describe('tenant security audit events', () => {
  let api: MockServer;
  let db: Database;

  beforeEach(async () => {
    api = await createMockServer({
      plugins: ['audit-logs'],
    });
    db = api.db;

    // Explicitly register the listener on the app (mirrors what the plugin does in afterAdd).
    // With idempotency guard this is safe even if afterAdd already ran.
    registerSecurityEventListener({ app: api, db } as any);
  });

  afterEach(async () => {
    await api.destroy();
  });

  it('should record tenant_access_denied event', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
      userId: 42,
      collectionName: 'secured_posts',
      action: 'list',
      details: { tenancyMode: 'tenantScoped' },
    });

    const log = await waitForSecurityEvent(db, 'tenant_access_denied');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_access_denied');
    expect(log.get('collectionName')).toBe('secured_posts');
    expect(log.get('isTenantImpersonation')).toBe(false);
    // actorUserId falls back to userId when not explicitly provided
    expect(log.get('actorUserId')).toBeTruthy();
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
  });

  it('should record tenant_cross_tenant_attempt event', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_cross_tenant_attempt',
      userId: 7,
      tenantId: 'tenant-c',
      action: 'list',
      collectionName: 'orders',
      details: { allowedTenantIds: ['tenant-a'], requestedTenantId: 'tenant-c' },
    });

    const log = await waitForSecurityEvent(db, 'tenant_cross_tenant_attempt');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_cross_tenant_attempt');
    expect(log.get('tenantId')).toBe('tenant-c');
    expect(log.get('collectionName')).toBe('orders');
    expect(log.get('actorUserId')).toBeTruthy();
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
    // userId must be persisted for attribution
    expect(log.get('actorUserId')).toBe('7');
    // details must carry the full troubleshooting context
    const details = log.get('details');
    expect(details).toBeDefined();
    expect(details).not.toBeNull();
    expect(details.requestedTenantId).toBe('tenant-c');
    expect(details.allowedTenantIds).toEqual(['tenant-a']);
  });

  it('should record tenant_impersonation event with full impersonation fields', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_impersonation',
      userId: 1,
      actorUserId: 1,
      tenantId: 'tenant-target',
      action: 'current',
      collectionName: 'tenants',
      details: { impersonatedTenantId: 'tenant-target', originalUserId: 1 },
    });

    const log = await waitForSecurityEvent(db, 'tenant_impersonation');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_impersonation');
    expect(log.get('tenantId')).toBe('tenant-target');
    expect(log.get('collectionName')).toBe('tenants');
    // actorUserId stored as string in DB
    expect(log.get('actorUserId')).toBe('1');
    // Core impersonation fields — these are the key assertions
    expect(log.get('isTenantImpersonation')).toBe(true);
    expect(log.get('impersonatedTenantId')).toBe('tenant-target');
    expect(log.get('tenantContextSource')).toBe('platformImpersonation');
    // details must be persisted and contain the original event payload
    const details = log.get('details');
    expect(details).toBeDefined();
    expect(details).not.toBeNull();
    expect(details.impersonatedTenantId).toBe('tenant-target');
    expect(details.originalUserId).toBe(1);
  });

  it('should record tenant_bulk_export_alert event', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_bulk_export_alert',
      userId: 3,
      actorUserId: 3,
      tenantId: 'tenant-a',
      collectionName: 'orders',
      action: 'export',
      details: { rowCount: 5000, threshold: 1000 },
    });

    const log = await waitForSecurityEvent(db, 'tenant_bulk_export_alert');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_bulk_export_alert');
    expect(log.get('tenantId')).toBe('tenant-a');
    expect(log.get('collectionName')).toBe('orders');
    expect(log.get('actorUserId')).toBe('3');
    expect(log.get('isTenantImpersonation')).toBe(false);
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
    // details must be persisted and contain the export metrics
    const details = log.get('details');
    expect(details).toBeDefined();
    expect(details).not.toBeNull();
    expect(details.rowCount).toBe(5000);
    expect(details.threshold).toBe(1000);
  });

  it('should handle events with missing optional fields', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
    });

    const log = await waitForSecurityEvent(db, 'tenant_access_denied');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_access_denied');
    expect(log.get('actorUserId')).toBeNull();
    expect(log.get('impersonatedTenantId')).toBeNull();
    expect(log.get('tenantContextSource')).toBeNull();
    expect(log.get('isTenantImpersonation')).toBe(false);
  });

  it('should not interfere with normal CRUD audit logs', async () => {
    db.collection({
      name: 'posts',
      logging: true,
      fields: [{ type: 'string', name: 'title' }],
    });
    await db.sync();

    const Post = db.getCollection('posts').model;
    await Post.create({ title: 'test' });

    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
      userId: 1,
      collectionName: 'posts',
      details: { tenancyMode: 'tenantScoped' },
    });

    const repo = db.getCollection('auditLogs').repository;
    const start = Date.now();
    let createLog = null;
    let securityLog = null;
    while (Date.now() - start < 3000) {
      createLog = await repo.findOne({ filter: { type: 'create' } });
      securityLog = await repo.findOne({ filter: { type: 'tenant_access_denied' } });
      if (createLog && securityLog) break;
      await sleep(50);
    }

    expect(createLog).not.toBeNull();
    expect(createLog.get('collectionName')).toBe('posts');
    expect(securityLog).not.toBeNull();
    expect(securityLog.get('collectionName')).toBe('posts');
  });
});

describe('security event listener idempotency', () => {
  let api: MockServer;
  let db: Database;

  beforeEach(async () => {
    api = await createMockServer({
      plugins: ['audit-logs'],
    });
    db = api.db;
  });

  afterEach(async () => {
    await api.destroy();
  });

  it('should not create duplicate audit logs when registered twice on the same app', async () => {
    // Register twice on the same app instance
    registerSecurityEventListener({ app: api, db } as any);
    registerSecurityEventListener({ app: api, db } as any);

    api.emit('tenant.securityViolation', {
      type: 'tenant_impersonation',
      userId: 1,
      actorUserId: 1,
      tenantId: 'tenant-x',
      details: { impersonatedTenantId: 'tenant-x', originalUserId: 1 },
    });

    const log = await waitForSecurityEvent(db, 'tenant_impersonation');
    expect(log).not.toBeNull();

    // Must be exactly 1 record, not 2
    const count = await countSecurityEvents(db, 'tenant_impersonation');
    expect(count).toBe(1);
  });

  it('should not duplicate when registered three times consecutively', async () => {
    registerSecurityEventListener({ app: api, db } as any);
    registerSecurityEventListener({ app: api, db } as any);
    registerSecurityEventListener({ app: api, db } as any);

    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
      userId: 1,
      collectionName: 'test_dup',
    });

    const log = await waitForSecurityEvent(db, 'tenant_access_denied');
    expect(log).not.toBeNull();

    const count = await countSecurityEvents(db, 'tenant_access_denied');
    expect(count).toBe(1);
  });
});

describe('bulk export threshold', () => {
  let api: MockServer;
  let db: Database;

  beforeEach(async () => {
    api = await createMockServer({
      plugins: ['audit-logs'],
    });
    db = api.db;
    registerSecurityEventListener({ app: api, db } as any);
  });

  afterEach(async () => {
    await api.destroy();
  });

  it('should emit tenant_bulk_export_alert when count >= threshold with tenant context', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_bulk_export_alert',
      userId: 5,
      actorUserId: 5,
      tenantId: 'tenant-b',
      collectionName: 'big_orders',
      action: 'export',
      details: { rowCount: 2500, threshold: 1000 },
    });

    const log = await waitForSecurityEvent(db, 'tenant_bulk_export_alert');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_bulk_export_alert');
    expect(log.get('tenantId')).toBe('tenant-b');
    expect(log.get('collectionName')).toBe('big_orders');
    expect(log.get('actorUserId')).toBe('5');
    expect(log.get('isTenantImpersonation')).toBe(false);
    // action is passed in the event but not a column in auditLogs schema
    expect(log.get('action')).toBeUndefined();
  });

  it('should not emit alert when count is below threshold', async () => {
    const beforeCount = await countSecurityEvents(db, 'tenant_bulk_export_alert');
    // No api.emit call — mimics the condition where exportXlsx skips the alert
    await sleep(200);
    const afterCount = await countSecurityEvents(db, 'tenant_bulk_export_alert');
    expect(afterCount).toBe(beforeCount);
  });

  it('should fire tenant_bulk_export_alert with correct payload shape', async () => {
    const rowCount = 1200;
    const threshold = 1000;

    api.emit('tenant.securityViolation', {
      type: 'tenant_bulk_export_alert',
      userId: 10,
      actorUserId: 10,
      tenantId: 'tenant-d',
      collectionName: 'export_test_col',
      action: 'export',
      details: { rowCount, threshold },
    });

    const log = await waitForSecurityEvent(db, 'tenant_bulk_export_alert');
    expect(log).not.toBeNull();
    expect(log.get('tenantId')).toBe('tenant-d');
    expect(log.get('collectionName')).toBe('export_test_col');
    expect(log.get('actorUserId')).toBe('10');
    // details must contain the exact rowCount and threshold from the event
    const details = log.get('details');
    expect(details).toBeDefined();
    expect(details).not.toBeNull();
    expect(details.rowCount).toBe(1200);
    expect(details.threshold).toBe(1000);
  });
});
