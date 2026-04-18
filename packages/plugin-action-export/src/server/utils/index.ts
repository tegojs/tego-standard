export * from './columns2Appends';

import dayjs from 'dayjs';
import path from 'node:path';

export function sanitizeExportSegment(value: string) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'export';
}

export function getExportTenantId(source: any) {
  return source?.state?.currentTenant?.id ?? source?.state?.currentTenantId ?? source?.currentTenantId;
}

export function buildExportDownloadName(title: string, tenantId?: string) {
  const base = String(title || 'export').trim() || 'export';
  return tenantId ? `${base}_${sanitizeExportSegment(tenantId)}` : base;
}

export function buildWorkerExportFileName(resourceName: string, title: string, tenantId?: string) {
  const base = sanitizeExportSegment(title || resourceName || 'export');
  const tenantSuffix = tenantId ? `_${sanitizeExportSegment(tenantId)}` : '';
  return `${base}${tenantSuffix}_${dayjs().format('YYYYMMDDHHmm')}.xlsx`;
}

export function buildWorkerExportRelativePath(fileName: string, tenantId?: string) {
  return tenantId
    ? path.posix.join('storage/uploads', 'tenants', sanitizeExportSegment(tenantId), fileName)
    : path.posix.join('storage/uploads', fileName);
}

export function buildWorkerExportSavePath(rootPath: string, tenantId?: string) {
  return tenantId ? path.join(rootPath, 'tenants', sanitizeExportSegment(tenantId)) : rootPath;
}
