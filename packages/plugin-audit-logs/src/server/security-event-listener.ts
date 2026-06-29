import type { Plugin } from '@tego/server';

import { EVENT_TENANT_SECURITY } from './constants';

export interface TenantSecurityEvent {
  type: string;
  userId?: number | string;
  actorUserId?: number | string;
  tenantId?: string;
  collectionName?: string;
  action?: string;
  details?: Record<string, any>;
}

/**
 * Listens for tenant security violation events emitted via ctx.app.emit()
 * and writes them directly to the auditLogs table.
 *
 * Security events bypass the normal model-hook debounce pipeline
 * because they fire on rejection paths (low volume, high importance).
 */
export function registerSecurityEventListener(plugin: { app: any; db: any }) {
  plugin.app.on(EVENT_TENANT_SECURITY, async (event: TenantSecurityEvent) => {
    try {
      const auditLogRepo = plugin.db.getRepository('auditLogs');
      await auditLogRepo.model.create({
        type: event.type,
        collectionName: event.collectionName || null,
        recordId: null,
        userId: event.userId ?? null,
        tenantId: event.tenantId ?? null,
        actorUserId: event.actorUserId ?? event.userId ?? null,
        impersonatedTenantId: null,
        tenantContextSource: null,
        isTenantImpersonation: false,
        details: event.details || null,
      });
    } catch {
      // Security event logging must never break the request path
    }
  });
}
