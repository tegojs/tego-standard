import type { Context } from '@tego/server';

type TenantFilterContext = {
  state?: Context['state'];
  action?: Pick<Context['action'], 'actionName' | 'params' | 'mergeParams'>;
};

function stripTenantFilter(filter: any): any {
  if (!filter || typeof filter !== 'object') {
    return filter;
  }

  if (Array.isArray(filter)) {
    return filter
      .map(stripTenantFilter)
      .filter((item) => item && (typeof item !== 'object' || Object.keys(item).length > 0));
  }

  const next = Object.fromEntries(
    Object.entries(filter)
      .filter(([key]) => key !== 'tenantId' && !key.startsWith('tenantId.'))
      .map(([key, value]) => [key, stripTenantFilter(value)]),
  );

  for (const key of ['$and', '$or']) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].filter((item: any) => item && (typeof item !== 'object' || Object.keys(item).length > 0));
      if (next[key].length === 0) {
        delete next[key];
      }
    }
  }

  return next;
}

function appendFilter(original: any, tenantId: string | number) {
  const tenantFilter = { tenantId };
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || Object.keys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function appendInheritedFilter(original: any, tenantIds: Array<string | number>) {
  const tenantFilter = { tenantId: { $in: tenantIds } };
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || Object.keys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function appendTenantValue(values: any, tenantId: string | number) {
  if (Array.isArray(values)) {
    return values.map((item) => ({
      ...item,
      tenantId,
    }));
  }

  return {
    ...values,
    tenantId,
  };
}

function omitTenantValue(values: any) {
  if (!values || typeof values !== 'object') {
    return values;
  }

  if (Array.isArray(values)) {
    return values.map(omitTenantValue);
  }

  const { tenantId, ...rest } = values;
  return rest;
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
  const tenancyMode = ctx.state.currentTenancyMode;

  let tenantParams: Record<string, any> | null = null;

  if (['list', 'get', 'count', 'update', 'destroy', 'export'].includes(actionName)) {
    if (tenancyMode === 'tenantInherited') {
      const descendantIds: Array<string | number> = ctx.state.currentTenantDescendantIds || [];
      const allIds = [tenantId, ...descendantIds];
      tenantParams = {
        filter: appendInheritedFilter(params?.filter, allIds),
      };
    } else {
      tenantParams = {
        filter: appendFilter(params?.filter, tenantId),
      };
    }
  }

  if (actionName === 'update') {
    tenantParams = {
      ...tenantParams,
      values: omitTenantValue(params?.values),
    };
  }

  if (tenantParams) {
    ctx.action.mergeParams(tenantParams);
    ctx.action.params.filter = tenantParams.filter;
    if (actionName === 'update') {
      ctx.action.params.values = tenantParams.values;
    }
  }

  if (actionName === 'create') {
    ctx.action.mergeParams({
      values: appendTenantValue(params?.values, tenantId),
    });
  }
}

export default applyTenantFilter;
