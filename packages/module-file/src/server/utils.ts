import crypto from 'node:crypto';
import path from 'node:path';

export function getFilename(req, file, cb) {
  crypto.pseudoRandomBytes(16, function (err, raw) {
    cb(err, err ? undefined : `${raw.toString('hex')}${path.extname(file.originalname)}`);
  });
}

export function getCurrentTenantId(ctx) {
  return ctx?.state?.currentTenant?.id ?? ctx?.state?.currentTenantId;
}

function sanitizeTenantStorageSegment(value: string) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized === '.' || normalized === '..' ? 'tenant' : normalized || 'tenant';
}

export function getTenantStoragePath(storagePath: string = '', tenantId?: string) {
  const normalizedStoragePath = String(storagePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  if (!tenantId) {
    return normalizedStoragePath;
  }

  const safeTenantId = sanitizeTenantStorageSegment(tenantId);
  const segments = normalizedStoragePath ? [normalizedStoragePath, 'tenants', safeTenantId] : ['tenants', safeTenantId];
  return path.posix.join(...segments);
}

export const cloudFilenameGetter = (storage) => (req, file, cb) => {
  getFilename(req, file, (err, filename) => {
    if (err) {
      return cb(err);
    }
    cb(null, `${storage.path ? `${storage.path}/` : ''}${filename}`);
  });
};
