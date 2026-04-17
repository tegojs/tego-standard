import type { Context, Next } from '@tego/server';

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

  return tenantUsers.map((item: any) => item.get('tenantId'));
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

  return currentUser?.get('defaultTenantId') || tenantIds[0];
}

export async function setCurrentTenant(ctx: Context, next: Next) {
  if (!ctx.state.currentUser) {
    return next();
  }

  const requestedTenantId = ctx.get('X-Tenant');
  const allowedTenantIds = await resolveAllowedTenantIds(ctx);

  let currentTenantId = requestedTenantId;
  if (!currentTenantId) {
    currentTenantId = await resolveDefaultTenantId(ctx, allowedTenantIds);
  }

  if (!currentTenantId) {
    return next();
  }

  if (!allowedTenantIds.includes(currentTenantId)) {
    ctx.throw(403, 'Invalid tenant access');
  }

  const currentTenant = await ctx.db.getRepository('tenants').findOne({
    filterByTk: currentTenantId,
  });

  if (!currentTenant) {
    ctx.throw(403, 'Tenant not found');
  }

  ctx.state.currentTenant = currentTenant.toJSON();
  ctx.state.currentTenantId = currentTenant.get('id');

  await next();
}

export default setCurrentTenant;
