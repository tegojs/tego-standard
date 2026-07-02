import type { Context, Next } from '@tego/server';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';
import { isPlatformTenantImpersonatorContext } from '../helpers/platform-tenant';
import { getDescendantIds } from '../helpers/tenant-tree';

/**
 * Emit a security violation event on the Application EventEmitter.
 *
 * ctx.app inside Koa middleware is the Koa instance, but plugin-audit-logs
 * registers its security listener on the Application instance.  The tenant
 * plugin stores a back-reference (ctx.app.__application) so we can reach it.
 */
function emitSecurityViolation(ctx: Context, event: Record<string, any>) {
  const app = (ctx.app as any).__application;
  if (app && typeof app.emit === 'function') {
    app.emit('tenant.securityViolation', event);
  } else {
    const logger = (ctx as any).log || (ctx as any).logger || (ctx as any).tego?.logger || (ctx.app as any).logger;
    logger?.warn?.(
      'Application emitter back-reference is missing; tenant.securityViolation is emitted on Koa app fallback',
      {
        eventType: event?.type,
        action: event?.action,
        collectionName: event?.collectionName,
      },
    );
    ctx.app.emit('tenant.securityViolation', event);
  }
}

function shouldFallbackForTenantBootstrap(ctx: Context) {
  return ctx.action?.resourceName === 'tenants' && ['available', 'current', 'switch'].includes(ctx.action?.actionName);
}

async function resolveAllowedTenantIds(ctx: Context) {
  const currentUser = ctx.state.currentUser;
  if (!currentUser) {
    return [];
  }

  const tenantUsers = await ctx.db.getRepository('tenantUsers').find({
    filter: {
      userId: currentUser.id,
    },
  });

  const tenantIds = tenantUsers.map((item: any) => item.get('tenantId'));
  return getAccessibleTenantIds(ctx.db, tenantIds);
}

async function resolveDefaultTenantId(ctx: Context, tenantIds: Array<string | number>) {
  if (tenantIds.length === 0) {
    return null;
  }

  const currentUser = await ctx.db.getRepository('users').findOne({
    filterByTk: ctx.state.currentUser.id,
  });

  const defaultTenantId = currentUser?.get('defaultTenantId');
  if (defaultTenantId != null && tenantIds.includes(defaultTenantId)) {
    return defaultTenantId;
  }

  const sortedTenantIds = [...tenantIds].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true }),
  );
  return sortedTenantIds[0];
}

export async function setCurrentTenant(ctx: Context, next: Next) {
  if (!ctx.state.currentUser && ctx.auth?.user) {
    ctx.state.currentUser = ctx.auth.user;
  }

  if (!ctx.state.currentUser) {
    return next();
  }

  // Idempotency guard: setCurrentTenant is registered on both the app-level
  // and resourcer middleware chains.  Without this guard, a single request
  // would resolve the tenant twice and emit duplicate security events.
  if (ctx.state.currentTenantId) {
    return next();
  }

  const requestedTenantId = ctx.get('X-Tenant-Id');
  const allowedTenantIds = await resolveAllowedTenantIds(ctx);
  const canImpersonateTenant = !!requestedTenantId && isPlatformTenantImpersonatorContext(ctx);

  let currentTenantId = requestedTenantId;
  if (
    currentTenantId &&
    !allowedTenantIds.includes(currentTenantId) &&
    !canImpersonateTenant &&
    shouldFallbackForTenantBootstrap(ctx)
  ) {
    currentTenantId = null;
  }

  if (!currentTenantId) {
    currentTenantId = await resolveDefaultTenantId(ctx, allowedTenantIds);
  }

  if (!currentTenantId) {
    return next();
  }

  const isImpersonatingTenant =
    !!currentTenantId && !allowedTenantIds.includes(currentTenantId) && canImpersonateTenant;

  if (!isImpersonatingTenant && !allowedTenantIds.includes(currentTenantId)) {
    // Resolve the user's actual tenant so the audit log is queryable
    // by the user's current tenant context (not the forged value).
    const actualTenantId = await resolveDefaultTenantId(ctx, allowedTenantIds);
    emitSecurityViolation(ctx, {
      type: 'tenant_cross_tenant_attempt',
      userId: ctx.state.currentUser?.id,
      tenantId: actualTenantId ?? null,
      action: ctx.action?.actionName,
      collectionName: ctx.action?.resourceName,
      details: { allowedTenantIds, requestedTenantId },
    });
    ctx.throw(403, 'Invalid tenant access');
  }

  const currentTenant = await ctx.db.getRepository('tenants').findOne({
    filter: {
      id: currentTenantId,
      enabled: true,
    },
  });

  if (!currentTenant) {
    ctx.throw(403, 'Tenant not found');
  }

  ctx.state.currentTenant = currentTenant.toJSON();
  ctx.state.currentTenantId = currentTenant.get('id');
  ctx.state.actorUserId = ctx.state.currentUser.id;
  ctx.state.tenantContextSource = isImpersonatingTenant ? 'platformImpersonation' : 'membership';
  ctx.state.impersonatedTenantId = isImpersonatingTenant ? ctx.state.currentTenantId : null;
  ctx.state.isTenantImpersonation = isImpersonatingTenant;

  if (isImpersonatingTenant) {
    emitSecurityViolation(ctx, {
      type: 'tenant_impersonation',
      userId: ctx.state.currentUser?.id,
      actorUserId: ctx.state.currentUser?.id,
      tenantId: currentTenantId as string,
      action: ctx.action?.actionName,
      collectionName: ctx.action?.resourceName,
      details: { impersonatedTenantId: currentTenantId, originalUserId: ctx.state.currentUser?.id },
    });
  }

  // Resolve descendant IDs for inherited tenancy mode filtering
  const descendantIds = await getDescendantIds(ctx.db.getRepository('tenants'), currentTenantId as string);
  ctx.state.currentTenantDescendantIds = descendantIds;

  await next();
}

export default setCurrentTenant;
