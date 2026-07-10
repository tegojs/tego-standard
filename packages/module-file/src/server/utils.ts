import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Generates a random upload filename while preserving the original extension.
 */
export function getFilename(req, file, cb) {
  crypto.randomBytes(16, function (err, raw) {
    cb(err, err ? undefined : `${raw.toString('hex')}${path.extname(file.originalname)}`);
  });
}

/**
 * Reads the effective tenant ID from the request state used by file storage.
 */
export function getCurrentTenantId(ctx) {
  return ctx?.state?.currentTenant?.id ?? ctx?.state?.currentTenantId;
}

function sanitizeTenantStorageSegment(value: string | number) {
  const normalized = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized === '.' || normalized === '..' ? 'tenant' : normalized || 'tenant';
}

function sanitizeTenantStoragePath(storagePath: string) {
  return storagePath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.')
    .map(sanitizeTenantStorageSegment)
    .filter(Boolean)
    .join('/');
}

/**
 * Builds the tenant-scoped storage path under a sanitized upload root.
 */
export function getTenantStoragePath(storagePath: string = '', tenantId?: string | number) {
  const normalizedStoragePath = String(storagePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const safeStoragePath = sanitizeTenantStoragePath(normalizedStoragePath);

  if (tenantId === null || tenantId === undefined || tenantId === '') {
    return safeStoragePath;
  }

  const safeTenantId = sanitizeTenantStorageSegment(tenantId);
  const segments = safeStoragePath ? [safeStoragePath, 'tenants', safeTenantId] : ['tenants', safeTenantId];
  return path.posix.join(...segments);
}

/**
 * Creates a multer-compatible filename callback for cloud storage uploads.
 */
export const cloudFilenameGetter = (storage) => (req, file, cb) => {
  getFilename(req, file, (err, filename) => {
    if (err) {
      return cb(err);
    }
    cb(null, `${storage.path ? `${storage.path}/` : ''}${filename}`);
  });
};
