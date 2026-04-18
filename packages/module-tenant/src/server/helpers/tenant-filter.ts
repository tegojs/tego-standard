import type { Context } from '@tego/server';

type TenantFilterContext = {
  state?: Context['state'];
  action?: Pick<Context['action'], 'actionName' | 'params' | 'mergeParams'>;
};

function appendFilter(original: any, tenantId: string | number) {
  const tenantFilter = { tenantId };

  if (!original || Object.keys(original).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [original, tenantFilter],
  };
}

export function applyTenantFilter(ctx: TenantFilterContext) {
  const tenantId = ctx.state.currentTenant?.id ?? ctx.state.currentTenantId;
  if (!tenantId) {
    return;
  }

  if (!ctx.action) {
    return;
  }

  const { actionName, params } = ctx.action;
  if (['list', 'get', 'count', 'update', 'destroy', 'export'].includes(actionName)) {
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
