import { randomUUID } from 'node:crypto';
import path from 'node:path';

import dayjs from 'dayjs';

export * from './columns2Appends';

export class ExportColumnsError extends Error {
  constructor(message: string) {
    super(`Invalid export columns: ${message}`);
    this.name = 'ExportColumnsError';
  }
}

function parseColumns(columns: any) {
  if (columns == null || columns === '') {
    return [];
  }

  if (typeof columns !== 'string') {
    return columns;
  }

  try {
    return JSON.parse(columns);
  } catch {
    throw new ExportColumnsError('columns must be valid JSON');
  }
}

function normalizeColumn(column: any, index: number) {
  if (typeof column === 'string') {
    if (!column.trim()) {
      throw new ExportColumnsError(`columns[${index}] must be a non-empty string`);
    }
    return { dataIndex: [column] };
  }

  if (!column || typeof column !== 'object' || Array.isArray(column)) {
    throw new ExportColumnsError(`columns[${index}] must be a string or object with dataIndex`);
  }

  if (!Array.isArray(column.dataIndex) || column.dataIndex.length === 0) {
    throw new ExportColumnsError(`columns[${index}].dataIndex must be a non-empty array`);
  }

  for (const [dataIndexPosition, segment] of column.dataIndex.entries()) {
    if (typeof segment !== 'string' || !segment.trim()) {
      throw new ExportColumnsError(`columns[${index}].dataIndex[${dataIndexPosition}] must be a non-empty string`);
    }
  }

  return column;
}

export function normalizeExportColumns(columns: any) {
  const parsedColumns = parseColumns(columns);

  if (!Array.isArray(parsedColumns)) {
    throw new ExportColumnsError('columns must be an array');
  }

  return parsedColumns.map(normalizeColumn);
}

export function filterExportColumnsByCollection(columns: any[], collection: any) {
  return columns.filter((col) => col?.dataIndex?.length > 0 && collection.hasField(col.dataIndex[0]));
}

type TenantId = string | number | undefined | null;

function hasTenantId(tenantId: TenantId) {
  return tenantId !== null && tenantId !== undefined && tenantId !== '';
}

export function sanitizeExportSegment(value: string | number) {
  const normalized = String(value ?? '')
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

export function buildExportDownloadName(title: string, tenantId?: TenantId) {
  const base =
    String(title || 'export')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_') || 'export';
  return hasTenantId(tenantId) ? `${base}_${sanitizeExportSegment(tenantId)}` : base;
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
  const logger = ctx.tego?.logger || ctx.app?.logger;
  logger?.warn?.(
    'Application emitter back-reference is missing; tenant security events may not reach audit listeners',
    {
      resourceName: ctx.action?.resourceName,
      actionName: ctx.action?.actionName,
    },
  );
  return ctx.app;
}

export function emitSecurityViolation(ctx: any, event: Record<string, any>) {
  try {
    const emitter = resolveApplicationEmitter(ctx);
    emitter.emit('tenant.securityViolation', event);
  } catch (error) {
    const logger = ctx.tego?.logger || ctx.app?.logger;
    logger?.warn?.('Failed to emit tenant security event; export flow will continue', {
      resourceName: ctx.action?.resourceName,
      actionName: ctx.action?.actionName,
      eventType: event?.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildWorkerExportFileName(resourceName: string, title: string, tenantId?: TenantId) {
  const base = sanitizeExportSegment(title || resourceName || 'export');
  const tenantSuffix = hasTenantId(tenantId) ? `_${sanitizeExportSegment(tenantId)}` : '';
  const uniqueSuffix = randomUUID().slice(0, 8);
  return `${base}${tenantSuffix}_${dayjs().format('YYYYMMDDHHmm')}_${uniqueSuffix}.xlsx`;
}

export function buildWorkerExportRelativePath(
  fileName: string,
  tenantId?: TenantId,
  basePath: string = 'storage/uploads',
) {
  return hasTenantId(tenantId)
    ? path.posix.join(basePath, 'tenants', sanitizeExportSegment(tenantId), fileName)
    : path.posix.join(basePath, fileName);
}

export function buildWorkerExportSavePath(rootPath: string, tenantId?: TenantId) {
  return hasTenantId(tenantId) ? path.join(rootPath, 'tenants', sanitizeExportSegment(tenantId)) : rootPath;
}
