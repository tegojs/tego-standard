import type { Context, Next } from '@tego/server';

import { getAccessibleTenantIds } from '../helpers/accessible-tenants';
import { isPlatformTenantImpersonatorContext } from '../helpers/platform-tenant';

/**
 * Switches the current user's default tenant after validating access to the requested tenant.
 */
export async function switchTenant(ctx: Context, next: Next) {
  const tenantId = ctx.action.params?.values?.tenantId;
  if (tenantId == null) {
    ctx.throw(400, 'tenantId is required');
  }

  const currentUserId = ctx.state.currentUser?.id;
  if (currentUserId == null) {
    ctx.throw(401, 'Authentication required');
  }

  const switchCurrentTenant = async (transaction?: any) => {
    const transactionOptions = transaction ? { transaction } : {};
    const tenant = await ctx.db.getRepository('tenants').findOne({
      filter: {
        id: tenantId,
        enabled: true,
      },
      ...transactionOptions,
    });

    if (!tenant) {
      ctx.throw(403, 'Invalid tenant access');
    }

    if (!isPlatformTenantImpersonatorContext(ctx)) {
      const tenantUsers = await ctx.db.getRepository('tenantUsers').find({
        filter: {
          userId: currentUserId,
        },
        ...transactionOptions,
      });
      const accessibleTenantIds = await getAccessibleTenantIds(
        ctx.db,
        tenantUsers.map((item: any) => item.get('tenantId')),
        transactionOptions,
      );

      if (!accessibleTenantIds.includes(tenantId)) {
        ctx.throw(403, 'Invalid tenant access');
      }
    }

    await ctx.db.getRepository('users').update({
      filterByTk: currentUserId,
      values: {
        defaultTenantId: tenantId,
      },
      ...transactionOptions,
    });

    return tenant;
  };

  const tenant = ctx.db.sequelize?.transaction
    ? await ctx.db.sequelize.transaction((transaction: any) => switchCurrentTenant(transaction))
    : await switchCurrentTenant();

  ctx.state.currentTenant = tenant?.toJSON();
  ctx.state.currentTenantId = tenant?.get('id');
  ctx.body = ctx.state.currentTenant || null;
  await next();
}

export default switchTenant;
