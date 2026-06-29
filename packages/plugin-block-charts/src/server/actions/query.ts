import { Cache, Context, Field, FilterParser, getDateVars, Next, parseFilter, snakeCase } from '@tego/server';

import compose from 'koa-compose';

import { formatter } from './formatter';

type MeasureProps = {
  field: string | string[];
  type?: string;
  aggregation?: string;
  alias?: string;
};

type DimensionProps = {
  field: string | string[];
  type?: string;
  alias?: string;
  format?: string;
};

type OrderProps = {
  field: string | string[];
  alias?: string;
  order?: 'asc' | 'desc';
};

type QueryParams = Partial<{
  uid: string;
  dataSource: string;
  collection: string;
  measures: MeasureProps[];
  dimensions: DimensionProps[];
  orders: OrderProps[];
  filter: any;
  limit: number;
  sql: {
    fields?: string;
    clauses?: string;
  };
  cache: {
    enabled: boolean;
    ttl: number;
  };
  // Get the latest data from the database
  refresh: boolean;
}>;

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

function appendTenantFilter(original: any, tenantFilter: any) {
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || Object.keys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function getCurrentTenantId(ctx: Context) {
  return ctx.state.currentTenant?.id ?? ctx.state.currentTenantId;
}

function normalizeTenantIds(ids?: Array<string | number>) {
  return (ids || []).map((item) => `${item}`).sort();
}

function getLegacyDataTenantIds(ctx: Context, collection: any) {
  if (Array.isArray(ctx.state.currentLegacyDataTenantIds)) {
    return ctx.state.currentLegacyDataTenantIds;
  }

  return collection?.options?.legacyDataTenantIds || [];
}

function getTenantCacheScope(ctx: Context, params: QueryParams) {
  const tenantId = getCurrentTenantId(ctx);

  if (!tenantId) {
    return null;
  }

  const db = getDB(ctx, params.dataSource) || ctx.db;
  const collection = params.collection ? db?.getCollection?.(params.collection) : null;
  const tenancyMode = collection?.options?.tenancy ?? ctx.state.currentTenancyMode;

  if (tenancyMode !== 'tenantScoped' && tenancyMode !== 'tenantInherited') {
    return null;
  }

  return {
    tenancyMode,
    tenantDescendantIds:
      tenancyMode === 'tenantInherited' ? normalizeTenantIds(ctx.state.currentTenantDescendantIds) : [],
    legacyDataTenantIds: normalizeTenantIds(getLegacyDataTenantIds(ctx, collection)),
  };
}

function stableSerialize(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

const getDB = (ctx: Context, dataSource: string) => {
  if (!dataSource) {
    return;
  }
  const ds = ctx.tego?.dataSourceManager?.dataSources.get(dataSource);
  return ds?.collectionManager.db;
};

function getChartCacheKey(ctx: Context, uid: string) {
  const tenantId = getCurrentTenantId(ctx);
  const currentUserId = ctx.state.currentUser?.id;
  const values = ctx.action.params.values as QueryParams;
  const { dataSource, collection: collectionName, measures, dimensions, orders, filter, limit, sql } = values;
  const db = getDB(ctx, dataSource) || ctx.db;
  const collection = collectionName ? db?.getCollection?.(collectionName) : null;
  const tenancyMode = collection?.options?.tenancy;
  const isTenantCollection = tenancyMode === 'tenantScoped' || tenancyMode === 'tenantInherited';
  const normalizedFilter = isTenantCollection ? stripTenantFilter(filter) : filter;
  const timezone = ctx.get?.('x-timezone');
  const signature = stableSerialize({
    dataSource,
    collection: collectionName,
    measures,
    dimensions,
    orders,
    filter: normalizedFilter,
    limit,
    sql,
    timezone,
    currentUserId,
    tenantScope: getTenantCacheScope(ctx, values),
  });

  if (!tenantId) {
    return `${uid}:query:${signature}`;
  }

  return `${uid}:tenant:${tenantId}:query:${signature}`;
}

export const postProcess = async (ctx: Context, next: Next) => {
  const { data, fieldMap } = ctx.action.params.values as {
    data: any[];
    fieldMap: { [source: string]: { type?: string } };
  };
  ctx.body = data.map((record) => {
    Object.entries(record).forEach(([key, value]) => {
      if (!value) {
        return;
      }
      const { type } = fieldMap[key] || {};
      switch (type) {
        case 'bigInt':
        case 'integer':
        case 'float':
        case 'double':
          record[key] = Number(value);
          break;
      }
    });
    return record;
  });
  await next();
};

export const queryData = async (ctx: Context, next: Next) => {
  const { dataSource, collection, queryParams, fieldMap } = ctx.action.params.values;
  const db = getDB(ctx, dataSource) || ctx.db;
  const model = db.getModel(collection);
  const data = await model.findAll(queryParams);
  ctx.action.params.values = {
    data,
    fieldMap,
  };
  await next();
  // if (!sql) {
  //   return await repository.find(parseBuilder(ctx, { collection, measures, dimensions, orders, filter, limit }));
  // }

  // const statement = `SELECT ${sql.fields} FROM ${collection} ${sql.clauses}`;
  // const [data] = await ctx.db.sequelize.query(statement);
  // return data;
};

export const parseBuilder = async (ctx: Context, next: Next) => {
  const { dataSource, measures, dimensions, orders, include, where, limit } = ctx.action.params.values;
  const db = getDB(ctx, dataSource) || ctx.db;
  const { sequelize } = db;
  const attributes = [];
  const group = [];
  const order = [];
  const fieldMap = {};
  let hasAgg = false;

  measures.forEach((measure: MeasureProps & { field: string }) => {
    const { field, aggregation, alias } = measure;
    const attribute = [];
    const col = sequelize.col(field);
    if (aggregation) {
      hasAgg = true;
      attribute.push(sequelize.fn(aggregation, col));
    } else {
      attribute.push(col);
    }
    if (alias) {
      attribute.push(alias);
    }
    attributes.push(attribute.length > 1 ? attribute : attribute[0]);
    fieldMap[alias || field] = measure;
  });

  dimensions.forEach((dimension: DimensionProps & { field: string }) => {
    const { field, format, alias, type } = dimension;
    const attribute = [];
    const col = sequelize.col(field);
    if (format) {
      attribute.push(formatter(sequelize, type, field, format, ctx.get('x-timezone')));
    } else {
      attribute.push(col);
    }
    if (alias) {
      attribute.push(alias);
    }
    attributes.push(attribute.length > 1 ? attribute : attribute[0]);
    if (hasAgg) {
      group.push(attribute[0]);
    }
    fieldMap[alias || field] = dimension;
  });

  orders.forEach((item: OrderProps) => {
    const alias = sequelize.getQueryInterface().quoteIdentifier(item.alias);
    const name = hasAgg ? sequelize.literal(alias) : sequelize.col(item.field as string);
    order.push([name, item.order || 'ASC']);
  });

  ctx.action.params.values = {
    ...ctx.action.params.values,
    queryParams: {
      where,
      attributes,
      include,
      group,
      order,
      limit: limit || 2000,
      subQuery: false,
      raw: true,
    },
    fieldMap,
  };
  await next();
};

export const parseFieldAndAssociations = async (ctx: Context, next: Next) => {
  const {
    dataSource,
    collection: collectionName,
    measures,
    dimensions,
    orders,
    filter,
  } = ctx.action.params.values as QueryParams;
  const db = getDB(ctx, dataSource) || ctx.db;
  const collection = db.getCollection(collectionName);
  const fields = collection.fields;
  const models: {
    [target: string]: {
      type: string;
    };
  } = {};
  const parseField = (selected: { field: string | string[]; alias?: string }) => {
    let target: string;
    let name: string;
    if (!Array.isArray(selected.field)) {
      name = selected.field;
    } else if (selected.field.length === 1) {
      name = selected.field[0];
    } else if (selected.field.length > 1) {
      [target, name] = selected.field;
    }
    const rawAttributes = collection.model.getAttributes();
    let field = rawAttributes[name]?.field || name;
    let fieldType = fields.get(name)?.type;
    if (target) {
      const targetField = fields.get(target) as Field;
      const targetCollection = db.getCollection(targetField.target);
      const targetFields = targetCollection.fields;
      fieldType = targetFields.get(name)?.type;
      field = `${target}.${field}`;
      name = `${target}.${name}`;
      const targetType = fields.get(target)?.type;
      if (!models[target]) {
        models[target] = { type: targetType };
      }
    } else {
      field = `${collectionName}.${field}`;
    }
    return {
      ...selected,
      field,
      name,
      type: fieldType,
      alias: selected.alias || name,
    };
  };

  const parsedMeasures = measures?.map(parseField) || [];
  const parsedDimensions = dimensions?.map(parseField) || [];
  const parsedOrders = orders?.map(parseField) || [];
  const include = Object.entries(models).map(([target, { type }]) => ({
    association: target,
    attributes: [],
    ...(type === 'belongsToMany' ? { through: { attributes: [] } } : {}),
  }));

  const filterParser = new FilterParser(filter, {
    collection,
  });
  const { where, include: filterInclude } = filterParser.toSequelizeParams();
  addBelongsToManyThrough(filterInclude, collectionName, ctx.db);

  ctx.action.params.values = {
    ...ctx.action.params.values,
    where,
    measures: parsedMeasures,
    dimensions: parsedDimensions,
    orders: parsedOrders,
    include: [...include, ...(filterInclude || [])],
  };
  await next();
};

// 针对多对多添加{ through: { attributes: [] } }
function addBelongsToManyThrough(include, collectionName, db) {
  if (!include) {
    return;
  }
  const collection = db.getCollection(collectionName);
  if (!collection) {
    return;
  }
  const fields = collection.fields;
  for (const item of include) {
    if (fields.get(item.association)?.type === 'belongsToMany') {
      item.through = { attributes: [] };
    }
    if (item.include) {
      addBelongsToManyThrough(item.include, fields.get(item.association)?.target, db);
    }
  }
}

export const parseVariables = async (ctx: Context, next: Next) => {
  const { filter } = ctx.action.params.values;
  if (!filter) {
    return next();
  }
  const isNumeric = (str: any) => {
    if (typeof str === 'number') return true;
    if (typeof str != 'string') return false;
    return !isNaN(str as any) && !isNaN(parseFloat(str));
  };
  const getUser = () => {
    return async ({ fields }) => {
      const userFields = fields.filter((f) => f && ctx.db.getFieldByPath('users.' + f));
      ctx.logger?.info('parse filter variables', { userFields, method: 'parseVariables' });
      if (!ctx.state.currentUser) {
        return;
      }
      if (!userFields.length) {
        return;
      }
      const user = await ctx.db.getRepository('users').findOne({
        filterByTk: ctx.state.currentUser.id,
        fields: userFields,
      });
      ctx.logger?.info('parse filter variables', {
        $user: user?.toJSON(),
        method: 'parseVariables',
      });
      return user;
    };
  };
  ctx.action.params.values.filter = await parseFilter(filter, {
    timezone: ctx.get('x-timezone'),
    now: new Date().toISOString(),
    getField: (path: string) => {
      const fieldPath = path
        .split('.')
        .filter((p) => !p.startsWith('$') && !isNumeric(p))
        .join('.');
      const { resourceName } = ctx.action;
      return ctx.db.getFieldByPath(`${resourceName}.${fieldPath}`);
    },
    vars: {
      $nDate: getDateVars(),
      $user: getUser(),
    },
  });
  await next();
};

export const applyTenantScope = async (ctx: Context, next: Next) => {
  const { dataSource, collection: collectionName, filter } = ctx.action.params.values as QueryParams;
  const db = getDB(ctx, dataSource) || ctx.db;
  const collection = db.getCollection(collectionName);
  const tenancyMode = collection?.options?.tenancy;

  if (tenancyMode === 'tenantScoped' || tenancyMode === 'tenantInherited') {
    const tenantId = getCurrentTenantId(ctx);

    if (tenantId) {
      const includeLegacyData = canReadLegacyData(tenantId, getLegacyDataTenantIds(ctx, collection));
      const tenantFilter =
        tenancyMode === 'tenantInherited'
          ? buildInheritedTenantFilter([tenantId, ...(ctx.state.currentTenantDescendantIds || [])], includeLegacyData)
          : buildTenantFilter(tenantId, includeLegacyData);
      ctx.action.params.values.filter = appendTenantFilter(filter, tenantFilter);
    }
  }

  await next();
};

export const cacheMiddleware = async (ctx: Context, next: Next) => {
  const { uid, cache: cacheConfig, refresh } = ctx.action.params.values as QueryParams;
  const cache = ctx.tego.cacheManager.getCache('data-visualization') as Cache;
  const useCache = cacheConfig?.enabled && uid;
  const cacheKey = useCache ? getChartCacheKey(ctx, uid) : null;

  if (useCache && !refresh) {
    const data = await cache.get(cacheKey);
    if (data) {
      ctx.body = data;
      return;
    }
  }
  await next();
  if (useCache) {
    await cache.set(cacheKey, ctx.body, cacheConfig?.ttl * 1000);
  }
};

const checkPermission = (ctx: Context, next: Next) => {
  // fix params not in the body
  if (ctx.action.params.values === undefined) {
    ctx.action.params.values = ctx.action.params;
  }
  const { collection } = ctx.action.params.values as QueryParams;
  const roleName = ctx.state.currentRole || 'anonymous';
  const can = ctx.tego.acl.can({ role: roleName, resource: collection, action: 'list' });
  if (!can && roleName !== 'root') {
    ctx.throw(403, 'No permissions');
  }
  return next();
};

export const query = async (ctx: Context, next: Next) => {
  try {
    await compose([
      checkPermission,
      cacheMiddleware,
      applyTenantScope,
      parseVariables,
      parseFieldAndAssociations,
      parseBuilder,
      queryData,
      postProcess,
    ])(ctx, next);
  } catch (err) {
    ctx.throw(500, err);
  }
};
