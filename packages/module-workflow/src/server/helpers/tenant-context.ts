type TenantFilterContext = {
  state?: Record<string, any>;
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
const TENANT_ENABLED_MODES = ['tenantScoped', 'tenantInherited'];

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

  if (!sanitizedOriginal || Object.keys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function appendInheritedFilter(original: any, tenantIds: Array<string | number>, includeLegacyData = false) {
  const tenantFilter = buildInheritedTenantFilter(tenantIds, includeLegacyData);
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

function getTenantId(state: TenantFilterContext['state']) {
  return state?.currentTenant?.id ?? state?.currentTenantId;
}

function buildTenantParams(actionName: string, params: any, state: TenantFilterContext['state'], tenancyMode?: string) {
  const tenantId = getTenantId(state);
  if (!tenantId) {
    return null;
  }

  const includeLegacyData = canReadLegacyData(tenantId, state?.currentLegacyDataTenantIds);
  let tenantParams: Record<string, any> | null = null;

  if (READ_ACTIONS.includes(actionName)) {
    if (tenancyMode === 'tenantInherited') {
      const descendantIds: Array<string | number> = state?.currentTenantDescendantIds || [];
      tenantParams = {
        filter: appendInheritedFilter(params?.filter, [tenantId, ...descendantIds], includeLegacyData),
      };
    } else {
      tenantParams = {
        filter: appendFilter(params?.filter, tenantId, includeLegacyData),
      };
    }
  }

  if (WRITE_FILTER_ACTIONS.includes(actionName)) {
    if (tenancyMode === 'tenantInherited') {
      const descendantIds: Array<string | number> = state?.currentTenantDescendantIds || [];
      tenantParams = {
        filter: appendInheritedFilter(params?.filter, [tenantId, ...descendantIds]),
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
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  actionName: string,
  options: TOptions,
) {
  const tenancyMode = collection?.options?.tenancy || context?.state?.currentTenancyMode;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode)) {
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

export async function getDescendantTenantIds(db: any, tenantId: string): Promise<string[]> {
  const repo = db?.getRepository?.('tenants');
  if (!repo) {
    return [];
  }

  const tenant = await repo.findOne({
    filter: { id: tenantId },
    fields: ['path'],
  });
  const path = tenant?.get('path') as string;
  if (!path) {
    return [];
  }

  const descendants = await repo.find({
    filter: {
      path: { $like: `${path}%` },
      'id.$ne': tenantId,
    },
    fields: ['id'],
  });

  return descendants.map((tenant: any) => tenant.get('id'));
}
