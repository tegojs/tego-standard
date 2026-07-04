import type { Plugin } from '@tego/server';

import { AUDIT_TYPE_TENANT_IMPERSONATION, EVENT_TENANT_SECURITY } from './constants';
import { normalizeActorUserId } from './normalize-audit-log-values';

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
const PENDING_SYMBOL = Symbol.for('auditLogs:securityEventListenerPending');
const SQLITE_BUSY_RETRY_DELAYS = [50, 100, 200];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSqliteBusyError(error: any) {
  return (
    error?.name === 'SequelizeTimeoutError' ||
    error?.original?.code === 'SQLITE_BUSY' ||
    error?.parent?.code === 'SQLITE_BUSY' ||
    String(error?.message || '').includes('SQLITE_BUSY')
  );
}

async function createSecurityAuditLog(plugin: { db: any }, values: Record<string, any>) {
  const auditLogRepo = plugin.db.getRepository('auditLogs');

  for (let attempt = 0; ; attempt++) {
    try {
      await auditLogRepo.model.create(values);
      return;
    } catch (error) {
      const retryDelay = SQLITE_BUSY_RETRY_DELAYS[attempt];
      if (!isSqliteBusyError(error) || retryDelay == null) {
        throw error;
      }
      await sleep(retryDelay);
    }
  }
}

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
  plugin.app[PENDING_SYMBOL] = plugin.app[PENDING_SYMBOL] || Promise.resolve();

  const persistEvent = async (event: TenantSecurityEvent) => {
    try {
      const isImpersonation = event.type === AUDIT_TYPE_TENANT_IMPERSONATION;
      const details = event.action ? { ...event.details, action: event.action } : event.details || null;

      await createSecurityAuditLog(plugin, {
        type: event.type,
        collectionName: event.collectionName || null,
        recordId: null,
        userId: event.userId ?? null,
        tenantId: event.tenantId ?? null,
        actorUserId: normalizeActorUserId(event.actorUserId ?? event.userId),
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

  const handler = (event: TenantSecurityEvent) => {
    const pending = plugin.app[PENDING_SYMBOL].catch(() => undefined).then(() => persistEvent(event));
    plugin.app[PENDING_SYMBOL] = pending.catch(() => undefined);
    return pending;
  };

  plugin.app.on(EVENT_TENANT_SECURITY, handler);
  plugin.app.on('beforeDestroy', async () => {
    await plugin.app[PENDING_SYMBOL];
  });
}
