import crypto from 'crypto';
import path from 'path';

export function getFilename(req, file, cb) {
  crypto.pseudoRandomBytes(16, function (err, raw) {
    cb(err, err ? undefined : `${raw.toString('hex')}${path.extname(file.originalname)}`);
  });
}

export function getCurrentTenantId(ctx) {
  return ctx?.state?.currentTenant?.id ?? ctx?.state?.currentTenantId;
}

export function getTenantStoragePath(storagePath: string = '', tenantId?: string) {
  const normalizedStoragePath = String(storagePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  if (!tenantId) {
    return normalizedStoragePath;
  }

  const segments = normalizedStoragePath ? [normalizedStoragePath, 'tenants', tenantId] : ['tenants', tenantId];
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
