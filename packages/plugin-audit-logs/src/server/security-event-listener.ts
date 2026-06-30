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
 * Global registry for security event handlers.
 *
 * ctx.app inside middleware resolves to the internal Koa instance, while
 * plugin.app is the Application — two separate EventEmitters.  To bridge
 * them without coupling to Koa lifecycle, handlers are stored in a global
 * map keyed by a stable app identifier.  The tenant module calls
 * dispatchTenantSecurityEvent() from middleware, which looks up and
 * invokes the handler directly.
 */
const GLOBAL_HANDLERS = Symbol.for('auditLogs:securityEventHandlers');

function getHandlerRegistry(): Map<string, (event: TenantSecurityEvent) => Promise<void>> {
  if (!(globalThis as any)[GLOBAL_HANDLERS]) {
    (globalThis as any)[GLOBAL_HANDLERS] = new Map();
  }
  return (globalThis as any)[GLOBAL_HANDLERS];
}

/**
 * Dispatch a tenant security event to the registered handler.
 * Called from tenant module middleware (setCurrentTenant, tenantResourceGuard).
 */
export function dispatchTenantSecurityEvent(event: TenantSecurityEvent, appId?: string) {
  const registry = getHandlerRegistry();
  const handler = registry.get(appId || 'default') || registry.values().next().value;
  if (handler) {
    handler(event).catch(() => {});
  }
}

/**
 * Listens for tenant security violation events emitted via ctx.app.emit()
 * and writes them directly to the auditLogs table.
 *
 * Security events bypass the normal model-hook debounce pipeline
 * because they fire on rejection paths (low volume, high importance).
 *
 * Idempotent: calling multiple times on the same app instance will not
 * register duplicate listeners.
 *
 * The handler is registered in three places:
 * 1. On the Application (EventEmitter) — for direct app.emit() calls
 * 2. On the internal Koa instance — for ctx.app.emit() calls from middleware
 * 3. In a global registry — for direct dispatch via dispatchTenantSecurityEvent()
 */
export function registerSecurityEventListener(plugin: { app: any; db: any }) {
  // Idempotency guard — one listener per app instance
  if (plugin.app[REGISTERED_SYMBOL]) {
    return;
  }
  plugin.app[REGISTERED_SYMBOL] = true;

  const handler = async (event: TenantSecurityEvent) => {
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
  };

  // 1. Register on the Application (EventEmitter) — for direct app.emit() calls
  plugin.app.on(EVENT_TENANT_SECURITY, handler);

  // 2. Register on the internal Koa instance — ctx.app inside middleware
  //    resolves to the Koa instance, which is a separate EventEmitter.
  //    The Koa instance may be recreated during app.reset(), so we also
  //    hook into the 'beforeStart' event to re-register after a reset.
  const registerOnKoa = () => {
    const koa = plugin.app._koa;
    if (koa && typeof koa.on === 'function' && !koa[REGISTERED_SYMBOL]) {
      koa[REGISTERED_SYMBOL] = true;
      koa.on(EVENT_TENANT_SECURITY, handler);
    }
  };
  registerOnKoa();
  if (typeof plugin.app.on === 'function') {
    plugin.app.on('beforeStart', registerOnKoa);
  }

  // 3. Register in global registry — for direct dispatch
  const registry = getHandlerRegistry();
  const appId = plugin.app.currentId || 'default';
  registry.set(appId, handler);
  // Also register as 'default' for fallback
  if (!registry.has('default')) {
    registry.set('default', handler);
  }
}
