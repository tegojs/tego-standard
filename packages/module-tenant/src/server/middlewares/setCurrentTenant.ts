import type { Context, Next } from '@tego/server';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';
import { getDescendantIds } from '../helpers/tenant-tree';

function shouldFallbackForTenantBootstrap(ctx: Context) {
  return ctx.action?.resourceName === 'tenants' && ['available', 'current', 'switch'].includes(ctx.action?.actionName);
}

function isPlatformTenantImpersonator(ctx: Context) {
  const roles = ctx.state.currentUser?.roles || [];
  return roles.some((role: any) => (typeof role === 'string' ? role : role?.name) === 'root');
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

  if (tenantIds.length === 1) {
    return tenantIds[0];
  }

  const currentUser = await ctx.db.getRepository('users').findOne({
    filterByTk: ctx.state.currentUser.id,
  });

  const defaultTenantId = currentUser?.get('defaultTenantId');
  if (defaultTenantId && tenantIds.includes(defaultTenantId)) {
    return defaultTenantId;
  }

  return tenantIds[0];
}

export async function setCurrentTenant(ctx: Context, next: Next) {
  if (!ctx.state.currentUser) {
    return next();
  }

  const requestedTenantId = ctx.get('X-Tenant-Id');
  const allowedTenantIds = await resolveAllowedTenantIds(ctx);
  const canImpersonateTenant = !!requestedTenantId && isPlatformTenantImpersonator(ctx);

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

  // Resolve descendant IDs for inherited tenancy mode filtering
  const descendantIds = await getDescendantIds(ctx.db.getRepository('tenants'), currentTenantId as string);
  ctx.state.currentTenantDescendantIds = descendantIds;

  await next();
}

export default setCurrentTenant;
