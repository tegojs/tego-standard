/**
 * Regression tests: module-tenant NOT loaded – plugin-audit-logs.
 *
 * When the tenant plugin is absent, audit log writes must still succeed.
 * Tenant-specific fields (tenantId, actorUserId, impersonatedTenantId, etc.)
 * are expected to be null/undefined — the write itself must not fail.
 */
import { createMockServer, MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { auditLogsTestPlugin } from './helpers';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAuditLogs(db: Database, expected: number, timeoutMs = 5000) {
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

describe('plugin-audit-logs – tenant module NOT loaded', () => {
  let api: MockServer;
  let db: Database;

  beforeEach(async () => {
    // Create server WITHOUT tenant plugin — only audit-logs and minimal deps
    api = await createMockServer({
      plugins: [auditLogsTestPlugin()],
    });
    db = api.db;

    db.collection({
      name: 'posts',
      logging: true,
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'status', defaultValue: 'draft' },
      ],
    });
    await db.sync();
  });

  afterEach(async () => {
    await api.destroy();
  });

  it('should write audit log on model create without tenant context', async () => {
    const Post = db.getCollection('posts').model;
    await Post.create({ title: 'hello' });

    const logs = await waitForAuditLogs(db, 1);
    expect(logs.length).toBe(1);
    expect(logs[0].get('type')).toBe('create');
    expect(logs[0].get('collectionName')).toBe('posts');
    expect(logs[0].get('tenantId')).toBeNull();
  });

  it('should write audit log on model update without tenant context', async () => {
    const Post = db.getCollection('posts').model;
    const post = await Post.create({ title: 'v1' });
    await post.update({ title: 'v2' });

    const logs = await waitForAuditLogs(db, 2);
    expect(logs.length).toBe(2);
    expect(logs[1].get('type')).toBe('update');
    expect(logs[1].get('tenantId')).toBeNull();
  });

  it('should write audit log on model destroy without tenant context', async () => {
    const Post = db.getCollection('posts').model;
    const post = await Post.create({ title: 'doomed' });
    await post.destroy();

    const logs = await waitForAuditLogs(db, 2);
    expect(logs.length).toBe(2);
    expect(logs[1].get('type')).toBe('destroy');
    expect(logs[1].get('tenantId')).toBeNull();
  });

  it('should write audit log via repository.create without tenant context', async () => {
    const postRepo = db.getRepository('posts');
    await postRepo.create({ values: { title: 'repo-created' } });

    const logs = await waitForAuditLogs(db, 1);
    expect(logs.length).toBe(1);
    expect(logs[0].get('collectionName')).toBe('posts');
    // All tenant fields should be null when tenant module is absent
    expect(logs[0].get('tenantId')).toBeNull();
    expect(logs[0].get('impersonatedTenantId')).toBeNull();
    expect(logs[0].get('isTenantImpersonation')).toBe(false);
  });
});
