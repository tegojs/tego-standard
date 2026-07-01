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

export function getCurrentTenantId(ctx: any) {
  return ctx?.state?.currentTenant?.id ?? ctx?.state?.currentTenantId;
}

export function withCurrentTenantFilter(ctx: any, filter: any = {}) {
  const tenantId = getCurrentTenantId(ctx);
  if (!tenantId) {
    return filter;
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

export function getTenantValuesFromExecution(execution: any) {
  const tenantId = execution?.get?.('tenantId') ?? execution?.tenantId;
  return tenantId ? { tenantId } : {};
}

export function getTenantWorkflowOptionsFromApproval(approval: any) {
  const tenantId = approval?.get?.('tenantId') ?? approval?.tenantId;
  if (!tenantId) {
    return {};
  }

  return {
    context: {
      state: {
        currentTenant: { id: tenantId },
        currentTenantId: tenantId,
        currentTenantDescendantIds: [],
        currentTenancyMode: 'tenantScoped',
        currentLegacyDataTenantIds: [],
      },
    },
  };
}
