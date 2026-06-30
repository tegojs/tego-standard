import path from 'node:path';

import dayjs from 'dayjs';

export * from './columns2Appends';

export function sanitizeExportSegment(value: string) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (normalized === '.' || normalized === '..') {
    return 'export';
  }

  return normalized || 'export';
}

export function getExportTenantId(source: any) {
  return source?.state?.currentTenant?.id ?? source?.state?.currentTenantId ?? source?.currentTenantId;
}

export function buildExportDownloadName(title: string, tenantId?: string) {
  const base =
    String(title || 'export')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_') || 'export';
  return tenantId ? `${base}_${sanitizeExportSegment(tenantId)}` : base;
}

/**
 * Resolve the Application EventEmitter from a Koa context.
 *
 * Inside Koa middleware ctx.app is the Koa instance, not the Application.
 * module-tenant stores a back-reference (ctx.app.__application) so we can
 * reach the Application's EventEmitter where plugin-audit-logs registers
 * its security listener.
 */
function resolveApplicationEmitter(ctx: any): { emit: (event: string, payload: any) => void } {
  const backRef = ctx.app?.__application;
  if (backRef && typeof backRef.emit === 'function') {
    return backRef;
  }
  return ctx.app;
}

export function emitSecurityViolation(ctx: any, event: Record<string, any>) {
  const emitter = resolveApplicationEmitter(ctx);
  emitter.emit('tenant.securityViolation', event);
}

export function buildWorkerExportFileName(resourceName: string, title: string, tenantId?: string) {
  const base = sanitizeExportSegment(title || resourceName || 'export');
  const tenantSuffix = tenantId ? `_${sanitizeExportSegment(tenantId)}` : '';
  return `${base}${tenantSuffix}_${dayjs().format('YYYYMMDDHHmm')}.xlsx`;
}

export function buildWorkerExportRelativePath(
  fileName: string,
  tenantId?: string,
  basePath: string = 'storage/uploads',
) {
  return tenantId
    ? path.posix.join(basePath, 'tenants', sanitizeExportSegment(tenantId), fileName)
    : path.posix.join(basePath, fileName);
}

export function buildWorkerExportSavePath(rootPath: string, tenantId?: string) {
  return tenantId ? path.join(rootPath, 'tenants', sanitizeExportSegment(tenantId)) : rootPath;
}
