import { applyTenantFilterToContext } from '@tachybase/module-tenant';

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
      next[key] = next[key].filter(
        (item: any) => item && (typeof item !== 'object' || Reflect.ownKeys(item).length > 0),
      );
      if (next[key].length === 0) {
        delete next[key];
      }
    }
  }

  return next;
}

/**
 * Provides the get current tenant id helper for this module.
 */
export function getCurrentTenantId(ctx: any) {
  return ctx?.state?.currentTenant?.id ?? ctx?.state?.currentTenantId;
}

function getCurrentCollection(ctx: any) {
  const collectionName = ctx?.action?.resourceName;
  return getCollection(ctx, collectionName);
}

function getCollection(ctx: any, collectionName?: string) {
  if (!collectionName) {
    return null;
  }

  return ctx?.db?.getCollection?.(collectionName) || null;
}

/**
 * Provides the with current tenant filter helper for this module.
 */
export function withCurrentTenantFilter(ctx: any, filter: any = {}) {
  const tenantId = getCurrentTenantId(ctx);
  if (tenantId === null || tenantId === undefined) {
    return filter;
  }

  const collection = getCurrentCollection(ctx);
  if (collection || ctx?.state?.currentTenancyMode) {
    return applyTenantFilterToContext(
      { state: ctx?.state },
      collection || { options: { tenancy: ctx.state.currentTenancyMode } },
      'list',
      { filter },
    ).filter;
  }

  const sanitizedFilter = stripTenantFilter(filter);
  const tenantFilter = { tenantId };

  if (!sanitizedFilter || Reflect.ownKeys(sanitizedFilter).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedFilter, tenantFilter],
  };
}

/**
 * Provides the get tenant values from context helper for this module.
 */
export function getTenantValuesFromContext(ctx: any, collectionName?: string) {
  const tenantId = getCurrentTenantId(ctx);
  if (tenantId === null || tenantId === undefined) {
    return {};
  }

  const collection = getCollection(ctx, collectionName);
  if (collection || ctx?.state?.currentTenancyMode) {
    return (
      applyTenantFilterToContext(
        { state: ctx?.state },
        collection || { options: { tenancy: ctx.state.currentTenancyMode } },
        'create',
        { values: {} },
      ).values || {}
    );
  }

  return { tenantId };
}

/**
 * Provides the get tenant values from execution helper for this module.
 */
export function getTenantValuesFromExecution(execution: any, collectionName?: string) {
  const tenantId = execution?.get?.('tenantId') ?? execution?.tenantId;
  if (tenantId === null || tenantId === undefined) {
    return {};
  }

  const tenantContext = execution?.get?.('tenantContext') ?? execution?.tenantContext ?? {};
  const db = execution?.constructor?.database;

  return getTenantValuesFromContext(
    {
      db,
      state: {
        ...tenantContext,
        currentTenant: tenantContext.currentTenant || { id: tenantId },
        currentTenantId: tenantContext.currentTenantId ?? tenantId,
      },
    },
    collectionName,
  );
}

/**
 * Provides the get tenant workflow options from approval helper for this module.
 */
export function getTenantWorkflowOptionsFromApproval(approval: any) {
  const tenantId = approval?.get?.('tenantId') ?? approval?.tenantId;
  if (tenantId === null || tenantId === undefined) {
    return {};
  }
  const tenantContext = approval?.get?.('tenantContext') ?? approval?.tenantContext ?? {};
  const collection = approval?.constructor?.database?.getCollection?.('approvals');

  return {
    context: {
      state: {
        currentTenant: { id: tenantId },
        currentTenantId: tenantId,
        currentTenantDescendantIds: tenantContext.currentTenantDescendantIds || [],
        currentTenancyMode: collection?.options?.tenancy || tenantContext.currentTenancyMode || 'tenantScoped',
        currentLegacyDataTenantIds:
          collection?.options?.legacyDataTenantIds || tenantContext.currentLegacyDataTenantIds || [],
      },
    },
  };
}
