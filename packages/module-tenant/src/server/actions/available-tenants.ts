import type { Context, Next } from '@tego/server';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';

export async function availableTenants(ctx: Context, next: Next) {
  const tenantUsers = await ctx.db.getRepository('tenantUsers').find({
    filter: {
      userId: ctx.state.currentUser?.id,
    },
  });

  const tenantIds = tenantUsers.map((item: any) => item.get('tenantId'));
  if (tenantIds.length === 0) {
    ctx.body = [];
    await next();
    return;
  }

  const accessibleTenantIds = await getAccessibleTenantIds(ctx.db, tenantIds);
  if (!accessibleTenantIds.length) {
    ctx.body = [];
    await next();
    return;
  }

  const tenants = await ctx.db.getRepository('tenants').find({
    filter: {
      id: {
        $in: accessibleTenantIds,
      },
      enabled: true,
    },
    sort: ['path', 'id'],
  });

  const currentTenantId = ctx.state.currentTenant?.id ?? ctx.state.currentTenantId;
  ctx.body = tenants.map((tenant: any) => ({
    ...tenant.toJSON(),
    current: tenant.get('id') === currentTenantId,
  }));

  await next();
}

export default availableTenants;
