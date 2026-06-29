import type { Plugin } from '@tego/server';

import { EVENT_TENANT_SECURITY } from './constants';

export interface TenantSecurityEvent {
  type: string;
  userId?: number | string;
  actorUserId?: number | string;
  tenantId?: string;
  collectionName?: string;
  action?: string;
  impersonatedTenantId?: string | null;
  tenantContextSource?: string | null;
  isTenantImpersonation?: boolean;
  details?: Record<string, any>;
}

const REGISTERED_SYMBOL = Symbol.for('auditLogs:securityEventListenerRegistered');

/**
 * Listens for tenant security violation events emitted via ctx.app.emit()
 * and writes them directly to the auditLogs table.
 *
 * Security events bypass the normal model-hook debounce pipeline
 * because they fire on rejection paths (low volume, high importance).
 *
 * Idempotent: calling multiple times on the same app instance will not
 * register duplicate listeners.
 */
export function registerSecurityEventListener(plugin: { app: any; db: any }) {
  // Idempotency guard — one listener per app instance
  if (plugin.app[REGISTERED_SYMBOL]) {
    return;
  }
  plugin.app[REGISTERED_SYMBOL] = true;

  plugin.app.on(EVENT_TENANT_SECURITY, async (event: TenantSecurityEvent) => {
    try {
      const isImpersonation = event.type === 'tenant_impersonation';

      const auditLogRepo = plugin.db.getRepository('auditLogs');
      await auditLogRepo.model.create({
        type: event.type,
        collectionName: event.collectionName || null,
        recordId: null,
        userId: event.userId ?? null,
        tenantId: event.tenantId ?? null,
        actorUserId: event.actorUserId ?? event.userId ?? null,
        impersonatedTenantId: isImpersonation
          ? (event.impersonatedTenantId ?? event.details?.impersonatedTenantId ?? event.tenantId ?? null)
          : (event.impersonatedTenantId ?? null),
        tenantContextSource: isImpersonation
          ? (event.tenantContextSource ?? 'platformImpersonation')
          : (event.tenantContextSource ?? null),
        isTenantImpersonation: isImpersonation ? true : (event.isTenantImpersonation ?? false),
        details: event.details || null,
      });
    } catch {
      // Security event logging must never break the request path
    }
  });
}
