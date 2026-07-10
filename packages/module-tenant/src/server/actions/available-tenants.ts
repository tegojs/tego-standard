import type { Context, Next } from '@tego/server';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';
import { isPlatformTenantImpersonatorContext } from '../helpers/platform-tenant';

function setAvailableTenantsBody(ctx: Context, tenants: any[]) {
  const currentTenantId = ctx.state.currentTenant?.id ?? ctx.state.currentTenantId;
  ctx.body = tenants.map((tenant: any) => ({
    ...tenant.toJSON(),
    current: tenant.get('id') === currentTenantId,
  }));
}

/**
 * Returns the enabled tenants visible to the current user or tenant impersonator.
 */
export async function availableTenants(ctx: Context, next: Next) {
  if (isPlatformTenantImpersonatorContext(ctx)) {
    const tenants = await ctx.db.getRepository('tenants').find({
      filter: {
        enabled: true,
      },
      sort: ['path', 'id'],
    });

    setAvailableTenantsBody(ctx, tenants);
    await next();
    return;
  }

  const currentUserId = ctx.state.currentUser?.id;
  if (currentUserId == null) {
    ctx.throw(401, 'Authentication required');
  }

  const tenantUsers = await ctx.db.getRepository('tenantUsers').find({
    filter: {
      userId: currentUserId,
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

  setAvailableTenantsBody(ctx, tenants);

  await next();
}

export default availableTenants;
