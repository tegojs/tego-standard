import type { Context, Next } from '@tego/server';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';

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

  const tenantUsers = await ctx.db.getRepository('tenantUsers').find({
    filter: {
      userId: ctx.state.currentUser?.id,
    },
  });
  const accessibleTenantIds = await getAccessibleTenantIds(
    ctx.db,
    tenantUsers.map((item: any) => item.get('tenantId')),
  );

  if (!accessibleTenantIds.includes(tenantId)) {
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
