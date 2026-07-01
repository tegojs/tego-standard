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
 * Listens for tenant security violation events emitted on the Application
 * (EventEmitter) and writes them directly to the auditLogs table.
 *
 * Security events bypass the normal model-hook debounce pipeline because
 * they fire on rejection paths (low volume, high importance).
 *
 * Idempotent: calling multiple times on the same app instance will not
 * register duplicate listeners.
 *
 * The tenant module stores a back-reference (ctx.app.__application) so that
 * setCurrentTenant / tenantResourceGuard can emit directly on the
 * Application instead of the Koa instance.
 */
export function registerSecurityEventListener(plugin: { app: any; db: any }) {
  if (plugin.app[REGISTERED_SYMBOL]) {
    return;
  }
  plugin.app[REGISTERED_SYMBOL] = true;

  const handler = async (event: TenantSecurityEvent) => {
    try {
      const isImpersonation = event.type === 'tenant_impersonation';
      const details = event.action ? { ...event.details, action: event.action } : event.details || null;

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
        details,
      });
    } catch (error) {
      plugin.app?.logger?.error?.('Failed to persist tenant security audit event', {
        error,
        event: {
          type: event.type,
          userId: event.userId,
          actorUserId: event.actorUserId,
          tenantId: event.tenantId,
          collectionName: event.collectionName,
          action: event.action,
          impersonatedTenantId: event.impersonatedTenantId,
          tenantContextSource: event.tenantContextSource,
          isTenantImpersonation: event.isTenantImpersonation,
        },
      });
      // Security event logging must never break the request path
    }
  };

  plugin.app.on(EVENT_TENANT_SECURITY, handler);
}
