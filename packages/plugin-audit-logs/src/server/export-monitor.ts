import type { Context, Next, Plugin } from '@tego/server';

import { BULK_EXPORT_THRESHOLD, EVENT_TENANT_SECURITY } from './constants';

/**
 * Koa middleware that monitors export responses on tenant-scoped collections.
 * If the exported row count exceeds BULK_EXPORT_THRESHOLD, emits a security event.
 */
export function createExportMonitor(_plugin: Plugin) {
  return async (ctx: Context, next: Next) => {
    await next();

    if (ctx.action?.actionName !== 'export') {
      return;
    }

    if (!ctx.state.currentTenancyMode) {
      return;
    }

    try {
      const body = ctx.body;
      const rows = Array.isArray(body) ? body : body?.data;

      if (Array.isArray(rows) && rows.length >= BULK_EXPORT_THRESHOLD) {
        ctx.app.emit(EVENT_TENANT_SECURITY, {
          type: 'tenant_bulk_export_alert',
          userId: ctx.state.currentUser?.id,
          actorUserId: ctx.state.actorUserId,
          tenantId: ctx.state.currentTenantId,
          collectionName: ctx.action.resourceName?.replace(/^api\//, ''),
          action: 'export',
          details: { rowCount: rows.length, threshold: BULK_EXPORT_THRESHOLD },
        });
      }
    } catch {
      // Monitor must never break the export response
    }
  };
}
