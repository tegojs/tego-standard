import type { Context, Next } from '@tego/server';

export async function switchTenant(ctx: Context, next: Next) {
  const tenantId = ctx.action.params?.values?.tenantId;
  if (!tenantId) {
    ctx.throw(400, 'tenantId is required');
  }

  const tenant = await ctx.db.getRepository('tenants').findOne({
    filter: {
      id: tenantId,
      enabled: true,
    },
  });

  if (!tenant) {
    ctx.throw(403, 'Invalid tenant access');
  }

  const tenantUsers = await ctx.db.getRepository('tenantUsers').findOne({
    filter: {
      userId: ctx.state.currentUser?.id,
      tenantId,
    },
  });

  if (!tenantUsers) {
    ctx.throw(403, 'Invalid tenant access');
  }

  await ctx.db.getRepository('users').update({
    filterByTk: ctx.state.currentUser.id,
    values: {
      defaultTenantId: tenantId,
    },
  });

  ctx.state.currentTenant = tenant?.toJSON();
  ctx.state.currentTenantId = tenant?.get('id');
  ctx.body = ctx.state.currentTenant || null;
  await next();
}

export default switchTenant;
