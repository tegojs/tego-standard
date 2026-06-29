/**
 * Regression tests: module-tenant NOT loaded.
 *
 * When the tenant plugin is absent, ctx.state has no currentTenant / currentTenantId.
 * File storage helpers must degrade gracefully: no tenant subdirectory, no tenantId
 * injection into attachment records.
 *
 * This file also covers the real upload action: even if a request carries
 * X-Tenant-Id, the server must NOT route files into a tenant path or stamp
 * tenantId on the attachment record when module-tenant is not loaded.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createMockServer, MockServer } from '@tachybase/test';

import send from 'koa-send';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FILE_FIELD_NAME, STORAGE_TYPE_LOCAL } from '../constants';
import { getCurrentTenantId, getTenantStoragePath } from '../utils';

const { LOCAL_STORAGE_BASE_URL, LOCAL_STORAGE_DEST = 'storage/uploads', APP_PORT = '3000' } = process.env;
const DEFAULT_LOCAL_BASE_URL = LOCAL_STORAGE_BASE_URL || `/storage/uploads`;
const textFilePath = path.resolve(__dirname, './files/text.txt');
const textFileExpectedContent = await fs.readFile(textFilePath, 'utf8');

// ---------------------------------------------------------------------------
// Helper: create mock server WITHOUT module-tenant
// ---------------------------------------------------------------------------

async function getAppWithoutTenant(): Promise<MockServer> {
  const app = await createMockServer({
    cors: { origin: '*' },
    registerActions: true,
    plugins: ['acl', 'users', 'collection-manager', 'error-handler', 'auth', 'data-source-manager', 'file-manager'],
    acl: false,
  });

  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/storage/uploads')) {
      await send(ctx, ctx.path, { root: process.env.TEGO_RUNTIME_HOME || process.cwd() });
      return;
    }
    await next();
  });

  await app.db.sync();
  return app;
}

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

// ---------------------------------------------------------------------------
// Real server upload – X-Tenant-Id must be ignored when tenant module absent
// ---------------------------------------------------------------------------

describe('module-file upload – tenant module NOT loaded', () => {
  let app: MockServer;
  let db;
  let agent;
  let AttachmentRepo;

  async function removeAttachmentFiles() {
    const attachments = await AttachmentRepo.find({ appends: ['storage'], paranoid: false });
    for (const attachment of attachments) {
      const storage = attachment.get('storage');
      if (!storage) continue;
      const { documentRoot = path.join('storage', 'uploads') } = storage.options || {};
      const destPath = path.resolve(
        path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
        storage.path,
      );
      try {
        await fs.unlink(path.join(destPath, attachment.filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          app.logger.error('Failed to remove attachment file', { filename: attachment.filename, destPath, error });
        }
      }
    }
  }

  async function resetFileData() {
    await removeAttachmentFiles();
    await AttachmentRepo.destroy({ truncate: true, force: true });
  }

  beforeAll(async () => {
    app = await getAppWithoutTenant();
    db = app.db;
    AttachmentRepo = db.getCollection('attachments').repository;
    agent = app.agent();
  });

  beforeEach(async () => {
    await resetFileData();
  });

  afterAll(async () => {
    await resetFileData();
    await app.destroy();
  });

  it('upload succeeds even with X-Tenant-Id header; path must NOT contain tenant segment', async () => {
    const { body } = await agent
      .set('X-Tenant-Id', 'rogue-tenant')
      .resource('attachments')
      .create({
        [FILE_FIELD_NAME]: textFilePath,
      });

    // 上传本身应成功
    expect(body.data).toBeTruthy();
    expect(body.data.id).toBeTruthy();

    // path 不得包含 tenants/rogue-tenant 或任何 tenants 段
    expect(body.data.path).not.toContain('tenants/rogue-tenant');
    expect(body.data.path).not.toContain('tenants');

    // tenantId 字段不得被注入
    expect(body.data.tenantId == null).toBe(true);

    // 数据库记录同样不得携带 tenantId
    const record = await AttachmentRepo.findOne({ filter: { id: body.data.id } });
    expect(record.get('tenantId') == null).toBe(true);

    // 实际文件必须落在普通 storage 路径下，而非 tenants/ 子目录
    const storage = await db.getCollection('storages').repository.findOne({ filter: { default: true } });
    const { documentRoot = path.join('storage', 'uploads') } = storage.options || {};
    const destPath = path.resolve(
      path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
      storage.path,
    );
    const filePath = path.join(destPath, body.data.filename);
    const fileContent = await fs.readFile(filePath, 'utf8');
    expect(fileContent).toBe(textFileExpectedContent);

    // 确保文件不在 tenants 子路径下
    const tenantFilePath = path.join(destPath, 'tenants', 'rogue-tenant', body.data.filename);
    await expect(fs.stat(tenantFilePath)).rejects.toThrow();
  });

  it('upload without X-Tenant-Id also produces no tenant path', async () => {
    const { body } = await agent.resource('attachments').create({
      [FILE_FIELD_NAME]: textFilePath,
    });

    expect(body.data).toBeTruthy();
    expect(body.data.path).not.toContain('tenants');
    expect(body.data.tenantId == null).toBe(true);
  });
});
