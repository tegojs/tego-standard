import type { Context } from '@tego/server';

function appendFilter(original: any, tenantId: string | number) {
  const tenantFilter = { tenantId };

  if (!original || Object.keys(original).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [original, tenantFilter],
  };
}

export function applyTenantFilter(ctx: Context) {
  const tenantId = ctx.state.currentTenant?.id ?? ctx.state.currentTenantId;
  if (!tenantId) {
    return;
  }

  const { actionName, params } = ctx.action;
  if (['list', 'get', 'count', 'update', 'destroy'].includes(actionName)) {
    ctx.action.mergeParams({
      filter: appendFilter(params?.filter, tenantId),
    });
  }

  if (actionName === 'create') {
    ctx.action.mergeParams({
      values: {
        ...(params?.values || {}),
        tenantId,
      },
    });
  }
}

export default applyTenantFilter;
