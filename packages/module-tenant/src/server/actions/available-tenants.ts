import type { Context, Next } from '@tego/server';

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

  // Collect the user's direct tenants and all their ancestor paths
  const directTenants = await ctx.db.getRepository('tenants').find({
    filter: {
      id: {
        $in: tenantIds,
      },
      enabled: true,
    },
    fields: ['id', 'path'],
  });

  // Gather ancestor tenant IDs from paths (so user can switch to parent tenants)
  const ancestorIds = new Set<string>();
  for (const tenant of directTenants) {
    const path = tenant.get('path') as string;
    if (path) {
      const segments = path.split('/').filter(Boolean);
      for (const seg of segments) {
        ancestorIds.add(seg);
      }
    }
  }

  const allRelevantIds = [...new Set([...tenantIds, ...ancestorIds])];

  const tenants = await ctx.db.getRepository('tenants').find({
    filter: {
      id: {
        $in: allRelevantIds,
      },
      enabled: true,
    },
    sort: ['id'],
  });

  const currentTenantId = ctx.state.currentTenant?.id ?? ctx.state.currentTenantId;
  ctx.body = tenants.map((tenant: any) => ({
    ...tenant.toJSON(),
    current: tenant.get('id') === currentTenantId,
  }));

  await next();
}

export default availableTenants;
