import { str2moment } from '@tego/server';

import dayjs from 'dayjs';
import * as math from 'mathjs';

import { namespace } from '../../';

const TENANT_ENABLED_MODES = ['tenantScoped', 'tenantInherited'];

function isTenantPluginEnabled(ctx: any) {
  for (const pluginManager of [ctx?.tego?.pm, ctx?.app?.pm]) {
    try {
      if (pluginManager?.get?.('tenant')?.enabled === true) {
        return true;
      }
    } catch {
      // Ignore plugin-manager lookup failures and fall back to request state.
    }
  }

  return false;
}

function appendTenantFilter(filter: any, tenantFilter: any) {
  if (!filter || Reflect.ownKeys(filter).length === 0) {
    return tenantFilter;
  }

  return { $and: [filter, tenantFilter] };
}

function throwMissingTenantContext(ctx: any): never {
  if (typeof ctx?.throw === 'function') {
    ctx.throw(403, 'Tenant context is required');
  }

  const error: any = new Error('Tenant context is required');
  error.status = 403;
  throw error;
}

function getRelationQueryOptions(ctx: any, target: string, repository: any, filter: any) {
  const collection = ctx.db.getCollection?.(target) || repository?.collection;
  const tenancyMode = collection?.options?.tenancy;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode)) {
    return { filter, context: ctx };
  }

  const tenantId = ctx.state?.currentTenant?.id ?? ctx.state?.currentTenantId;
  if (tenantId === null || tenantId === undefined) {
    if (isTenantPluginEnabled(ctx)) {
      throwMissingTenantContext(ctx);
    }

    return {
      filter,
      context: ctx,
    };
  }

  const tenantIds =
    tenancyMode === 'tenantInherited' ? [tenantId, ...(ctx.state?.currentTenantDescendantIds || [])] : null;
  const tenantFilter = tenantIds ? { tenantId: { $in: tenantIds } } : { tenantId };
  const legacyDataTenantIds = ctx.state?.currentLegacyDataTenantIds || collection?.options?.legacyDataTenantIds || [];
  const includeLegacyData = legacyDataTenantIds.some((item: string | number) => `${item}` === `${tenantId}`);
  const effectiveTenantFilter = includeLegacyData ? { $or: [tenantFilter, { tenantId: null }] } : tenantFilter;

  return {
    filter: appendTenantFilter(filter, effectiveTenantFilter),
    context: ctx,
  };
}

/**
 * Transforms imported generic value field values into application values.
 */
export async function _({ value, field }) {
  return value;
}

/**
 * Transforms imported email field values into application values.
 */
export async function email({ value, field, ctx }) {
  if (!value?.trim()) {
    return value;
  }
  const emailReg = /^([a-zA-Z0-9._-])+@([a-zA-Z0-9_-])+(\.[a-zA-Z0-9_-])+/;
  if (!emailReg.test(value)) {
    throw new Error(ctx.t('Incorrect email format', { ns: namespace }));
  }
  return value;
}

/**
 * Transforms imported password field values into application values.
 */
export async function password({ value, field, ctx }) {
  if (value === undefined || value === null) {
    throw new Error(ctx.t('password is empty', { ns: namespace }));
  }
  return `${value}`;
}

/**
 * Transforms imported o2o field values into application values.
 */
export async function o2o({ value, column, field, ctx }) {
  const { dataIndex, enum: enumData } = column;
  const repository = ctx.db.getRepository(field.options.target);
  let enumItem = null;
  if (enumData?.length > 0) {
    enumItem = enumData.find((e) => e.label === value);
  }
  const val = await repository.findOne(
    getRelationQueryOptions(ctx, field.options.target, repository, {
      [dataIndex[1]]: enumItem?.value ?? value,
    }),
  );
  return val;
}
export const oho = o2o;
export const obo = o2o;

/**
 * Transforms imported o2m field values into application values.
 */
export async function o2m({ value, column, field, ctx }) {
  let results = [];
  const values = value.split(';').map((val) => val.trim());
  const { dataIndex, enum: enumData } = column;
  const repository = ctx.db.getRepository(field.options.target);
  if (enumData?.length > 0) {
    const enumValues = values.map((val) => {
      const v = enumData.find((e) => e.label === val);
      if (v === undefined) {
        throw new Error(`not found enum value ${val}`);
      }
      return v.value;
    });
    results = await repository.find(
      getRelationQueryOptions(ctx, field.options.target, repository, { [dataIndex[1]]: enumValues }),
    );
  } else {
    results = await repository.find(
      getRelationQueryOptions(ctx, field.options.target, repository, { [dataIndex[1]]: values }),
    );
  }
  return results;
}

/**
 * Transforms imported m2o field values into application values.
 */
export async function m2o({ value, column, field, ctx }) {
  let results = null;
  const { dataIndex, enum: enumData } = column;
  const repository = ctx.db.getRepository(field.options.target);
  const normalizedValue = typeof value === 'string' ? value.trim() : value;
  if (enumData?.length > 0) {
    const enumItem = enumData.find((e) => e.label === normalizedValue);
    if (enumItem === undefined) {
      throw new Error(`not found enum value ${value}`);
    }
    results = await repository.findOne(
      getRelationQueryOptions(ctx, field.options.target, repository, { [dataIndex[1]]: enumItem.value }),
    );
  } else {
    results = await repository.findOne(
      getRelationQueryOptions(ctx, field.options.target, repository, { [dataIndex[1]]: normalizedValue }),
    );
  }
  return results;
}

/**
 * Transforms imported m2m field values into application values.
 */
export async function m2m({ value, column, field, ctx }) {
  let results = [];
  const values = value.split(';').map((val) => val.trim());
  const { dataIndex, enum: enumData } = column;
  const repository = ctx.db.getRepository(field.options.target);
  if (enumData?.length > 0) {
    const enumValues = values.map((val) => {
      const v = enumData.find((e) => e.label === val);
      if (v === undefined) {
        throw new Error(`not found enum value ${val}`);
      }
      return v.value;
    });
    results = await repository.find(
      getRelationQueryOptions(ctx, field.options.target, repository, { [dataIndex[1]]: enumValues }),
    );
  } else {
    results = await repository.find(
      getRelationQueryOptions(ctx, field.options.target, repository, { [dataIndex[1]]: values }),
    );
  }
  return results;
}
/**
 * Transforms imported datetime field values into application values.
 */
export async function datetime({ value, field, ctx }) {
  if (!value) {
    return '';
  }
  const utcOffset = ctx.get('X-Timezone');
  const props = field.options?.uiSchema?.['x-component-props'] ?? {};
  const m = str2moment(value, { ...props, utcOffset });
  if (!m.isValid()) {
    throw new Error(ctx.t('Incorrect date format', { ns: namespace }));
  }
  return m.toDate();
}
/**
 * Transforms imported time field values into application values.
 */
export async function time({ value, field, ctx }) {
  const { format } = field.options?.uiSchema?.['x-component-props'] ?? {};
  if (format) {
    const m = dayjs(value, format);
    if (!m.isValid()) {
      throw new Error(ctx.t('Incorrect time format', { ns: namespace }));
    }
    return m.format(format);
  }
  return value;
}
/**
 * Transforms imported percent field values into application values.
 */
export async function percent({ value, field, ctx }) {
  if (value) {
    const numberValue = Number(value?.split('%')?.[0] ?? value);
    if (isNaN(numberValue)) {
      throw new Error(ctx.t('Illegal percentage format', { ns: namespace }));
    }
    return math.round(numberValue / 100, 9);
  }
  return 0;
}
/**
 * Transforms imported checkbox field values into application values.
 */
export async function checkbox({ value, column, field, ctx }) {
  return value === ctx.t('Yes', { ns: namespace }) ? 1 : 0;
}

export const boolean = checkbox;

/**
 * Transforms imported select field values into application values.
 */
export async function select({ value, column, field, ctx }) {
  const { enum: enumData } = column;
  const item = enumData.find((item) => item.label === value);
  return item?.value;
}
export const radio = select;

export const radioGroup = select;

/**
 * Transforms imported multiple select field values into application values.
 */
export async function multipleSelect({ value, column, field, ctx }) {
  const values = value?.split(';');
  const { enum: enumData } = column;
  const results = values?.map((val) => {
    const item = enumData.find((item) => item.label === val);
    return item;
  });
  return results?.map((result) => result?.value);
}

export const checkboxes = multipleSelect;

export const checkboxGroup = multipleSelect;

/**
 * Transforms imported china region field values into application values.
 */
export async function chinaRegion({ value, column, field, ctx }) {
  const values = value?.split('/')?.map((val) => val.trim());
  const repository = ctx.db.getRepository('chinaRegions');
  const results = await repository.find({ filter: { name: values } });
  return results;
}
