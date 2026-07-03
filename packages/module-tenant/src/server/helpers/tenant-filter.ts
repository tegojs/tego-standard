import type { Context } from '@tego/server';

import { TENANT_ENABLED_MODES, TENANT_INHERITED_MODE } from '../constants';

type TenantFilterContext = {
  state?: Context['state'];
  action?: Pick<Context['action'], 'actionName' | 'params' | 'mergeParams'>;
};

type TenantFilterCollection = {
  options?: {
    tenancy?: string;
    legacyDataTenantIds?: Array<string | number>;
    [key: string]: any;
  };
  [key: string]: any;
};

const READ_ACTIONS = ['list', 'get', 'count', 'export', 'aggregate'];
const WRITE_FILTER_ACTIONS = ['update', 'destroy'];

function isEmptyPlainObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).length === 0;
}

function stripTenantFilter(filter: any): any {
  if (!filter || typeof filter !== 'object') {
    return filter;
  }

  if (Array.isArray(filter)) {
    return filter.map(stripTenantFilter);
  }

  const next: Record<PropertyKey, any> = {};
  for (const key of Reflect.ownKeys(filter)) {
    if (typeof key === 'string' && (key === 'tenantId' || key.startsWith('tenantId.'))) {
      continue;
    }
    next[key] = stripTenantFilter(filter[key]);
  }

  for (const key of ['$and', '$or']) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].filter((item: any) => !isEmptyPlainObject(item));
      if (next[key].length === 0) {
        delete next[key];
      }
    }
  }

  return next;
}

function canReadLegacyData(tenantId: string | number, legacyDataTenantIds?: Array<string | number>) {
  return (legacyDataTenantIds || []).some((item) => `${item}` === `${tenantId}`);
}

function buildTenantFilter(tenantId: string | number, includeLegacyData = false) {
  if (!includeLegacyData) {
    return { tenantId };
  }

  return {
    $or: [{ tenantId }, { tenantId: null }],
  };
}

function buildInheritedTenantFilter(tenantIds: Array<string | number>, includeLegacyData = false) {
  const tenantFilter = { tenantId: { $in: tenantIds } };

  if (!includeLegacyData) {
    return tenantFilter;
  }

  return {
    $or: [tenantFilter, { tenantId: null }],
  };
}

function appendFilter(original: any, tenantId: string | number, includeLegacyData = false) {
  const tenantFilter = buildTenantFilter(tenantId, includeLegacyData);
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || isEmptyPlainObject(sanitizedOriginal)) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function appendInheritedFilter(original: any, tenantIds: Array<string | number>, includeLegacyData = false) {
  const tenantFilter = buildInheritedTenantFilter(tenantIds, includeLegacyData);
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || isEmptyPlainObject(sanitizedOriginal)) {
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

function getTenantId(state: TenantFilterContext['state']) {
  return state?.currentTenant?.id ?? state?.currentTenantId;
}

function buildTenantParams(actionName: string, params: any, state: TenantFilterContext['state'], tenancyMode?: string) {
  const tenantId = getTenantId(state);
  if (tenantId == null) {
    return null;
  }

  const includeLegacyData = canReadLegacyData(tenantId, state?.currentLegacyDataTenantIds);
  let tenantParams: Record<string, any> | null = null;

  if (READ_ACTIONS.includes(actionName)) {
    if (tenancyMode === TENANT_INHERITED_MODE) {
      const descendantIds: Array<string | number> = state?.currentTenantDescendantIds || [];
      const allIds = [tenantId, ...descendantIds];
      tenantParams = {
        filter: appendInheritedFilter(params?.filter, allIds, includeLegacyData),
      };
    } else {
      tenantParams = {
        filter: appendFilter(params?.filter, tenantId, includeLegacyData),
      };
    }
  }

  if (WRITE_FILTER_ACTIONS.includes(actionName)) {
    if (tenancyMode === TENANT_INHERITED_MODE) {
      const descendantIds: Array<string | number> = state?.currentTenantDescendantIds || [];
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

  if (actionName === 'create') {
    tenantParams = {
      values: appendTenantValue(params?.values, tenantId),
    };
  }

  return tenantParams;
}

export function applyTenantFilterToContext<TOptions extends Record<string, any>>(
  context: Pick<TenantFilterContext, 'state'>,
  collection: TenantFilterCollection,
  actionName: string,
  options: TOptions,
) {
  const tenancyMode = collection?.options?.tenancy || context?.state?.currentTenancyMode;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
    return options;
  }

  const state = {
    ...context?.state,
    currentTenancyMode: tenancyMode,
    currentLegacyDataTenantIds: context?.state?.currentLegacyDataTenantIds || collection?.options?.legacyDataTenantIds,
  };
  const tenantParams = buildTenantParams(actionName, options, state, tenancyMode);

  if (!tenantParams) {
    return options;
  }

  return {
    ...options,
    ...tenantParams,
  };
}

export function applyTenantFilter(ctx: TenantFilterContext) {
  const tenantId = getTenantId(ctx.state);
  if (tenantId == null) {
    return;
  }

  if (!ctx.action) {
    return;
  }

  const { actionName, params } = ctx.action;
  const tenancyMode = ctx.state.currentTenancyMode;
  const tenantParams = buildTenantParams(actionName, params, ctx.state, tenancyMode);

  if (tenantParams) {
    ctx.action.mergeParams(tenantParams);
    if ('filter' in tenantParams) {
      ctx.action.params.filter = tenantParams.filter;
    }
    if ('values' in tenantParams) {
      ctx.action.params.values = tenantParams.values;
    }
  }
}

export default applyTenantFilter;
