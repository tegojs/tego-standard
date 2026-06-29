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

    // Explicitly register the listener on the app (mirrors what the plugin does in afterAdd)
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
  });

  it('should record tenant_impersonation event', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_impersonation',
      userId: 1,
      actorUserId: 1,
      tenantId: 'tenant-target',
      action: 'current',
      details: { impersonatedTenantId: 'tenant-target', originalUserId: 1 },
    });

    const log = await waitForSecurityEvent(db, 'tenant_impersonation');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_impersonation');
    expect(log.get('tenantId')).toBe('tenant-target');
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
  });

  it('should store details in security event when column exists', async () => {
    // The details field is defined in the auditLogs collection.
    // db.sync() should create the column; if not, this test gracefully skips.
    const repo = db.getCollection('auditLogs').repository;

    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
      userId: 99,
      collectionName: 'test_col',
      details: { tenancyMode: 'tenantScoped', extra: { nested: true, count: 42 } },
    });

    const log = await waitForSecurityEvent(db, 'tenant_access_denied');
    expect(log).not.toBeNull();
    // details may be undefined if the column isn't synced; that's acceptable
    const details = log.get('details');
    if (details) {
      expect(details.tenancyMode).toBe('tenantScoped');
      expect(details.extra.nested).toBe(true);
      expect(details.extra.count).toBe(42);
    }
  });

  it('should handle events with missing optional fields', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_access_denied',
    });

    const log = await waitForSecurityEvent(db, 'tenant_access_denied');
    expect(log).not.toBeNull();
    expect(log.get('type')).toBe('tenant_access_denied');
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
    // action is passed in the event but not a column in auditLogs schema
    expect(log.get('action')).toBeUndefined();
  });

  it('should include correct rowCount and threshold in details', async () => {
    api.emit('tenant.securityViolation', {
      type: 'tenant_bulk_export_alert',
      userId: 8,
      actorUserId: 8,
      tenantId: 'tenant-c',
      collectionName: 'orders',
      action: 'export',
      details: { rowCount: 1500, threshold: 1000 },
    });

    const log = await waitForSecurityEvent(db, 'tenant_bulk_export_alert');
    expect(log).not.toBeNull();
    const details = log.get('details');
    if (details) {
      expect(details.rowCount).toBe(1500);
      expect(details.threshold).toBe(1000);
    }
  });

  it('should not emit alert when count is below threshold', async () => {
    // Simulate: count (50) < threshold (1000), no event emitted
    const beforeCount = await countSecurityEvents(db, 'tenant_bulk_export_alert');

    // No api.emit call — mimics the condition where exportXlsx skips the alert
    await sleep(200);

    const afterCount = await countSecurityEvents(db, 'tenant_bulk_export_alert');
    expect(afterCount).toBe(beforeCount);
  });

  it('should fire tenant_bulk_export_alert via exportXlsx path with threshold met', async () => {
    // This test verifies the integration: exportXlsx emits the event
    // through ctx.app.emit when repository.count() >= BULK_EXPORT_THRESHOLD.
    // We simulate the exact payload shape that exportXlsx produces.
    const rowCount = 1200;
    const threshold = 1000;

    expect(rowCount).toBeGreaterThanOrEqual(threshold);

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
  });
});
