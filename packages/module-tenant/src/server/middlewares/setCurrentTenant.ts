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

  const tenantIds = tenantUsers.map((item: any) => item.get('tenantId'));
  if (tenantIds.length === 0) {
    return [];
  }

  const tenants = await ctx.db.getRepository('tenants').find({
    filter: {
      id: {
        $in: tenantIds,
      },
      enabled: true,
    },
  });

  return tenants.map((tenant: any) => tenant.get('id'));
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

  await next();
}

export default setCurrentTenant;
