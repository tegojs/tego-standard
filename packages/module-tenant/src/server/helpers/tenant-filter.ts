import type { Context } from '@tego/server';

import { TENANT_ENABLED_MODES, TENANT_INHERITED_MODE } from '../constants';
import { translateTenantError } from '../locale';

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
const NEVER_MATCH_TENANT_FILTER = { id: -1 };

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

function flattenAndFilters(filter: any): any {
  if (!filter || typeof filter !== 'object') {
    return filter;
  }

  if (Array.isArray(filter)) {
    return filter.map(flattenAndFilters);
  }

  const next: Record<PropertyKey, any> = {};
  for (const key of Reflect.ownKeys(filter)) {
    const value = flattenAndFilters(filter[key]);
    if (key === '$and' && Array.isArray(value)) {
      next[key] = value.flatMap((item: any) => {
        if (item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.$and)) {
          const { $and, ...siblings } = item;
          return Reflect.ownKeys(siblings).length > 0 ? [siblings, ...$and] : $and;
        }
        return [item];
      });
    } else {
      next[key] = value;
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

function appendTenantFilter(original: any, tenantFilter: any, normalizeAnd = false) {
  const sanitizedOriginal = stripTenantFilter(original);
  const normalizedOriginal = normalizeAnd ? flattenAndFilters(sanitizedOriginal) : sanitizedOriginal;

  if (!normalizedOriginal || isEmptyPlainObject(normalizedOriginal)) {
    return tenantFilter;
  }

  const combined = {
    $and: [normalizedOriginal, tenantFilter],
  };

  return normalizeAnd ? flattenAndFilters(combined) : combined;
}

export function isTenantReadAction(actionName: string) {
  return READ_ACTIONS.includes(actionName);
}

export function applyUnassignedTenantReadFilter(ctx: TenantFilterContext) {
  if (!ctx.action || !isTenantReadAction(ctx.action.actionName)) {
    return;
  }
  const tenantParams = {
    filter: appendTenantFilter(ctx.action.params?.filter, { tenantId: null }, true),
  };
  ctx.action.mergeParams(tenantParams);
  ctx.action.params.filter = tenantParams.filter;
}

export function applyLegacyTenantClaim(ctx: TenantFilterContext) {
  const tenantId = getTenantId(ctx.state);
  if (tenantId == null || !ctx.action) {
    throw new Error(translateTenantError(ctx, 'tenantContextRequired'));
  }

  const tenantParams = {
    filter: appendTenantFilter(ctx.action.params?.filter, { tenantId: null }),
    values: {
      ...ctx.action.params?.values,
      tenantId,
    },
  };
  ctx.action.mergeParams(tenantParams);
  ctx.action.params.filter = tenantParams.filter;
  ctx.action.params.values = tenantParams.values;
}

function appendFilter(original: any, tenantId: string | number, includeLegacyData = false, normalizeAnd = false) {
  return appendTenantFilter(original, buildTenantFilter(tenantId, includeLegacyData), normalizeAnd);
}

function appendInheritedFilter(
  original: any,
  tenantIds: Array<string | number>,
  includeLegacyData = false,
  normalizeAnd = false,
) {
  return appendTenantFilter(original, buildInheritedTenantFilter(tenantIds, includeLegacyData), normalizeAnd);
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

function buildTenantParams(
  actionName: string,
  params: any,
  state: TenantFilterContext['state'],
  tenancyMode?: string,
  context?: TenantFilterContext,
) {
  const tenantId = getTenantId(state);
  if (tenantId == null) {
    if (READ_ACTIONS.includes(actionName) || WRITE_FILTER_ACTIONS.includes(actionName)) {
      return actionName === 'update'
        ? {
            filter: NEVER_MATCH_TENANT_FILTER,
            values: omitTenantValue(params?.values),
          }
        : {
            filter: NEVER_MATCH_TENANT_FILTER,
          };
    }

    if (actionName === 'create') {
      throw new Error(translateTenantError(context, 'tenantContextRequired'));
    }

    return {};
  }

  const includeLegacyData = canReadLegacyData(tenantId, state?.currentLegacyDataTenantIds);
  let tenantParams: Record<string, any> | null = null;

  if (READ_ACTIONS.includes(actionName)) {
    if (tenancyMode === TENANT_INHERITED_MODE) {
      const descendantIds: Array<string | number> = state?.currentTenantDescendantIds || [];
      const allIds = [tenantId, ...descendantIds];
      tenantParams = {
        filter: appendInheritedFilter(params?.filter, allIds, includeLegacyData, true),
      };
    } else {
      tenantParams = {
        filter: appendFilter(params?.filter, tenantId, includeLegacyData, true),
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

/**
 * Returns repository options with the tenant predicate/value merged for a tenant-aware collection.
 */
export function applyTenantFilterToContext<TOptions extends Record<string, any>>(
  context: Pick<TenantFilterContext, 'state'>,
  collection: TenantFilterCollection,
  actionName: string,
  options: TOptions,
) {
  const tenancyMode = collection?.options?.tenancy;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
    return options;
  }

  const state = {
    ...context?.state,
    currentTenancyMode: tenancyMode,
    currentLegacyDataTenantIds: collection?.options?.legacyDataTenantIds ?? context?.state?.currentLegacyDataTenantIds,
  };
  const tenantParams = buildTenantParams(actionName, options, state, tenancyMode, context);

  if (!tenantParams) {
    return options;
  }

  return {
    ...options,
    ...tenantParams,
  };
}

/**
 * Applies the current request tenant context to resource action params in-place.
 */
export function applyTenantFilter(ctx: TenantFilterContext) {
  const tenantId = getTenantId(ctx.state);
  if (tenantId == null && !TENANT_ENABLED_MODES.includes(ctx.state?.currentTenancyMode as any)) {
    return;
  }

  if (!ctx.action) {
    return;
  }

  const { actionName, params } = ctx.action;
  const tenancyMode = ctx.state.currentTenancyMode;
  const tenantParams = buildTenantParams(actionName, params, ctx.state, tenancyMode, ctx);

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
