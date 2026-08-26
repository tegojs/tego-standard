import type { Context } from '@tego/server';

type TenantFilterContext = {
  state?: Record<string, any>;
  [key: string]: any;
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
/**
 * Sentinel filter used when missing tenant context must match no records.
 */
export const NEVER_MATCH_TENANT_FILTER = { id: -1 };

function buildPathPrefixFilter(path: string) {
  return {
    path: {
      $gte: path,
      $lt: `${path}\uffff`,
    },
  };
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

function canReadLegacyData(tenantId: string | number, legacyDataTenantIds?: Array<string | number>) {
  return (legacyDataTenantIds || []).some((item) => `${item}` === `${tenantId}`);
}

const LEGACY_RECORD_READ_ONLY =
  'This record is unassigned legacy data and is read-only. Ask an administrator to allow editing legacy data for this collection before trying again.';
const LEGACY_RECORD_DELETE_REQUIRES_CLAIM =
  'This record is unassigned legacy data and cannot be deleted directly. Edit it first to assign it to the current tenant, then try deleting it again.';
const RECORD_UNAVAILABLE =
  'This record or a related record is not available in the current tenant. It may belong to another tenant or have been removed.';
const TENANT_CONTEXT_REQUIRED =
  'No tenant is selected. Select a tenant and try again. If no tenant is available, contact an administrator.';

function tenantError(context: any, message: string) {
  return new Error(typeof context?.t === 'function' ? context.t(message, { ns: 'tenant' }) : message);
}

function requireCurrentTenantId(context: TenantFilterContext) {
  const tenantId = getCurrentTenantIdFromState(context?.state);
  if (!hasTargetKey(tenantId)) {
    throw tenantError(context, TENANT_CONTEXT_REQUIRED);
  }
  return tenantId;
}

export function workflowTenantRecordUnavailableError(context: any) {
  return tenantError(context, RECORD_UNAVAILABLE);
}

function getRecordValue(record: any, key: string) {
  return typeof record?.get === 'function' ? record.get(key) : record?.[key];
}

function hasTargetKey(value: any) {
  return value !== undefined && value !== null && value !== '';
}

function isEmptyAssociationPlaceholder(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === 0;
}

function removeEmptyAssociationPlaceholders(value: any) {
  if (isEmptyAssociationPlaceholder(value)) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return value;
  }
  const values = value.filter((item) => !isEmptyAssociationPlaceholder(item));
  return values.length === 0 && value.length > 0 ? undefined : values;
}

function getAssociationTargetCollection(db: any, association: any) {
  return db?.modelCollection?.get?.(association.target) || db?.getCollection?.(association.target?.name);
}

function normalizeComparableValue(value: any): any {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(normalizeComparableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeComparableValue(item)]),
    );
  }
  return value;
}

function hasSameValue(left: any, right: any) {
  if (left instanceof Date || right instanceof Date) {
    const leftTimestamp = new Date(left).getTime();
    const rightTimestamp = new Date(right).getTime();
    return !Number.isNaN(leftTimestamp) && leftTimestamp === rightTimestamp;
  }
  return JSON.stringify(normalizeComparableValue(left)) === JSON.stringify(normalizeComparableValue(right));
}

function hasSameTargetKey(left: any, right: any) {
  return hasTargetKey(left) && hasTargetKey(right) && `${left}` === `${right}`;
}

function hasUnchangedTargetKeyValue(sourceRecord: any, key: string, value: any) {
  const sourceRecords = Array.isArray(sourceRecord) ? sourceRecord : sourceRecord ? [sourceRecord] : [];
  return (
    sourceRecords.length > 0 && sourceRecords.every((record) => hasSameTargetKey(getRecordValue(record, key), value))
  );
}

function getAssociationTargetKeys(value: any, targetKey: string) {
  const targetKeys = [];
  for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) {
    const targetKeyValue =
      typeof item === 'string' || typeof item === 'number' ? item : getRecordValue(item, targetKey);
    if (!hasTargetKey(targetKeyValue)) {
      return null;
    }
    targetKeys.push(`${targetKeyValue}`);
  }
  return targetKeys.sort();
}

async function hasUnchangedAssociationValues(
  db: any,
  sourceRecord: any,
  association: any,
  associationValue: any,
  associationPath: string,
  updatePaths: Set<string>,
  transaction?: any,
) {
  if (Array.isArray(sourceRecord)) {
    if (sourceRecord.length === 0) {
      return false;
    }
    for (const record of sourceRecord) {
      if (
        !(await hasUnchangedAssociationValues(
          db,
          record,
          association,
          associationValue,
          associationPath,
          updatePaths,
          transaction,
        ))
      ) {
        return false;
      }
    }
    return true;
  }
  if (!sourceRecord) {
    return false;
  }
  const targetCollection = getAssociationTargetCollection(db, association);
  if (!targetCollection) {
    return false;
  }
  const targetKey = association.targetKey || 'id';
  const throughModelName = association.through?.model?.name;
  const requestedValues = Array.isArray(associationValue) ? associationValue : [associationValue];
  if (
    throughModelName &&
    requestedValues.some(
      (value) => value && typeof value === 'object' && getRecordValue(value, throughModelName) != null,
    )
  ) {
    return false;
  }

  const requestedTargetKeys = getAssociationTargetKeys(associationValue, targetKey);
  const getAccessor = association.accessors?.get;
  if (!requestedTargetKeys || !getAccessor || typeof sourceRecord[getAccessor] !== 'function') {
    return false;
  }
  const existingAssociationValue = await sourceRecord[getAccessor]({ transaction });
  const existingTargetKeys = getAssociationTargetKeys(existingAssociationValue, targetKey);
  if (
    existingTargetKeys === null ||
    requestedTargetKeys.length !== existingTargetKeys.length ||
    requestedTargetKeys.some((targetKeyValue, index) => targetKeyValue !== existingTargetKeys[index])
  ) {
    return false;
  }

  const existingRecords = Array.isArray(existingAssociationValue)
    ? existingAssociationValue
    : existingAssociationValue == null
      ? []
      : [existingAssociationValue];
  const existingRecordsByTargetKey = new Map(
    existingRecords.map((record) => [`${getRecordValue(record, targetKey)}`, record]),
  );

  for (const requestedValue of requestedValues) {
    if (requestedValue == null || typeof requestedValue === 'string' || typeof requestedValue === 'number') {
      continue;
    }
    const existingRecord = existingRecordsByTargetKey.get(`${getRecordValue(requestedValue, targetKey)}`);
    if (!existingRecord) {
      return false;
    }
    if (updatePaths.has(associationPath)) {
      for (const [key, requestedFieldValue] of Object.entries(requestedValue)) {
        if (key === targetKey || key in targetCollection.model.associations || key === throughModelName) {
          continue;
        }
        if (!hasSameValue(getRecordValue(existingRecord, key), requestedFieldValue)) {
          return false;
        }
      }
    }
    for (const [nestedAssociationName, nestedAssociation] of Object.entries<any>(targetCollection.model.associations)) {
      if (!(nestedAssociationName in requestedValue)) {
        continue;
      }
      if (
        !(await hasUnchangedAssociationValues(
          db,
          existingRecord,
          nestedAssociation,
          requestedValue[nestedAssociationName],
          `${associationPath}.${nestedAssociationName}`,
          updatePaths,
          transaction,
        ))
      ) {
        return false;
      }
    }
  }
  return true;
}

async function hasAssociationTargetChanges(
  db: any,
  targetCollection: any,
  targetRecord: any,
  value: Record<string, any>,
  targetKey: string,
  associationPath: string,
  updatePaths: Set<string>,
  throughModelName?: string,
  transaction?: any,
) {
  if (!updatePaths.has(associationPath)) {
    return false;
  }

  for (const [key, requestedValue] of Object.entries(value)) {
    if (key === targetKey || key === throughModelName) {
      continue;
    }
    const nestedAssociation = targetCollection.model?.associations?.[key];
    if (!nestedAssociation) {
      if (!hasSameValue(getRecordValue(targetRecord, key), requestedValue)) {
        return true;
      }
      continue;
    }
    const nestedAssociationPath = `${associationPath}.${key}`;
    if (
      updatePaths.has(nestedAssociationPath) &&
      !(await hasUnchangedAssociationValues(
        db,
        targetRecord,
        nestedAssociation,
        requestedValue,
        nestedAssociationPath,
        updatePaths,
        transaction,
      ))
    ) {
      return true;
    }
  }
  return false;
}

async function findReferenceableRecord(
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  repository: any,
  targetKey: string,
  targetKeyValue: any,
  transaction?: any,
) {
  const options = applyTenantFilterToContext(context, collection, 'get', {
    filter: { [targetKey]: targetKeyValue },
  });
  const record = await repository.findOne({ ...options, context, transaction });
  if (!record) {
    throw workflowTenantRecordUnavailableError(context);
  }
  return record;
}

/**
 * Validates association graphs written by workflow nodes. Existing legacy
 * targets may be referenced without ownership changes; actual target edits
 * follow that target collection's legacy-editing policy.
 */
export async function guardWorkflowTenantAssociationValues(
  context: TenantFilterContext,
  db: any,
  collection: TenantFilterCollection,
  values: any,
  options: Record<string, any> = {},
  transaction?: any,
  pathPrefix = '',
  sourceRecord?: any,
): Promise<any> {
  if (!values || typeof values !== 'object' || !collection?.model?.associations) {
    return values;
  }
  if (Array.isArray(values)) {
    for (const value of values) {
      await guardWorkflowTenantAssociationValues(context, db, collection, value, options, transaction, pathPrefix);
    }
    return values;
  }

  const configuredPaths = options.updateAssociationValues;
  const updatePaths = new Set<string>(
    (Array.isArray(configuredPaths) ? configuredPaths : configuredPaths ? [configuredPaths] : []).filter(Boolean),
  );

  for (const [associationName, association] of Object.entries<any>(collection.model.associations)) {
    const associationPath = pathPrefix ? `${pathPrefix}.${associationName}` : associationName;
    const targetCollection = getAssociationTargetCollection(db, association);
    if (!targetCollection) {
      continue;
    }
    const targetKey = collection.getField?.(associationName)?.targetKey || association.targetKey || 'id';
    const throughModelName = association.through?.model?.name;
    const tenantAwareTarget = TENANT_ENABLED_MODES.includes(targetCollection.options?.tenancy);
    const associationForeignKey = association.associationType === 'BelongsTo' ? association.foreignKey : null;
    if (associationName in values) {
      const associationValue = removeEmptyAssociationPlaceholders(values[associationName]);
      if (associationValue === undefined) {
        delete values[associationName];
      } else {
        values[associationName] = associationValue;
      }
    }
    if (
      associationName in values &&
      tenantAwareTarget &&
      (await hasUnchangedAssociationValues(
        db,
        sourceRecord,
        association,
        values[associationName],
        associationPath,
        updatePaths,
        transaction,
      ))
    ) {
      delete values[associationName];
    }
    const associationValues =
      associationName in values
        ? Array.isArray(values[associationName])
          ? values[associationName]
          : [values[associationName]]
        : [];

    if (
      tenantAwareTarget &&
      typeof associationForeignKey === 'string' &&
      associationForeignKey in values &&
      hasTargetKey(values[associationForeignKey]) &&
      !hasUnchangedTargetKeyValue(sourceRecord, associationForeignKey, values[associationForeignKey])
    ) {
      requireCurrentTenantId(context);
      await findReferenceableRecord(
        context,
        targetCollection,
        targetCollection.repository,
        targetKey,
        values[associationForeignKey],
        transaction,
      );
    }

    for (const associationValue of associationValues) {
      if (associationValue === null || associationValue === undefined) {
        continue;
      }

      if (typeof associationValue === 'string' || typeof associationValue === 'number') {
        if (tenantAwareTarget) {
          requireCurrentTenantId(context);
          await findReferenceableRecord(
            context,
            targetCollection,
            targetCollection.repository,
            targetKey,
            associationValue,
            transaction,
          );
        }
        continue;
      }
      if (typeof associationValue !== 'object') {
        continue;
      }

      const targetKeyValue = getRecordValue(associationValue, targetKey);
      let targetRecord;
      if (tenantAwareTarget && hasTargetKey(targetKeyValue)) {
        const tenantId = requireCurrentTenantId(context);
        targetRecord = await findReferenceableRecord(
          context,
          targetCollection,
          targetCollection.repository,
          targetKey,
          targetKeyValue,
          transaction,
        );
        const targetHasChanges = await hasAssociationTargetChanges(
          db,
          targetCollection,
          targetRecord,
          associationValue,
          targetKey,
          associationPath,
          updatePaths,
          throughModelName,
          transaction,
        );
        if (targetHasChanges) {
          if (getRecordValue(targetRecord, 'tenantId') === null) {
            if (targetCollection.options?.allowEditingLegacyData !== true) {
              throw tenantError(context, LEGACY_RECORD_READ_ONLY);
            }
            associationValue.tenantId = tenantId;
          } else {
            delete associationValue.tenantId;
          }
        } else {
          delete associationValue.tenantId;
        }
      } else if (tenantAwareTarget) {
        associationValue.tenantId = requireCurrentTenantId(context);
      } else if (hasTargetKey(targetKeyValue)) {
        targetRecord = await targetCollection.repository.findOne({
          filter: { [targetKey]: targetKeyValue },
          context,
          transaction,
        });
      }

      await guardWorkflowTenantAssociationValues(
        context,
        db,
        targetCollection,
        associationValue,
        options,
        transaction,
        associationPath,
        targetRecord,
      );
    }
  }
  return values;
}

function appendExactTenantFilter(original: any, tenantId: string | number | null) {
  const sanitizedOriginal = stripTenantFilter(original);
  const tenantFilter = { tenantId };
  if (!sanitizedOriginal || Reflect.ownKeys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }
  return { $and: [sanitizedOriginal, tenantFilter] };
}

function hasAssociationSourceValues(collection: TenantFilterCollection, values: any): boolean {
  if (Array.isArray(values)) {
    return values.some((value) => hasAssociationSourceValues(collection, value));
  }
  if (!values || typeof values !== 'object') {
    return false;
  }

  return Object.entries<any>(collection?.model?.associations || {}).some(([associationName, association]) => {
    if (associationName in values) {
      const associationValue = removeEmptyAssociationPlaceholders(values[associationName]);
      if (associationValue != null && (!Array.isArray(associationValue) || associationValue.length > 0)) {
        return true;
      }
    }
    return (
      association.associationType === 'BelongsTo' &&
      typeof association.foreignKey === 'string' &&
      association.foreignKey in values &&
      hasTargetKey(values[association.foreignKey])
    );
  });
}

/** Finds the source records whose association graphs are about to be updated. */
export async function findWorkflowTenantReadableRecords(
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  repository: any,
  options: Record<string, any>,
  transaction?: any,
) {
  if (!hasAssociationSourceValues(collection, options?.values)) {
    return [];
  }
  const readableOptions = applyTenantFilterToContext(context, collection, 'get', options);
  return repository.find({ ...readableOptions, context, transaction });
}

/**
 * Resolves one or more tenant-safe update plans. Legacy records are claimed by
 * the same update that modifies them, while records already owned by visible
 * tenants keep their existing ownership.
 */
export async function resolveTenantUpdatePlans(
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  repository: any,
  options: Record<string, any>,
  transaction?: any,
  config: { allowCreateWhenMissing?: boolean } = {},
) {
  const tenancyMode = collection?.options?.tenancy;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode)) {
    if (config.allowCreateWhenMissing) {
      const existingRecord = await repository.findOne({ ...options, context, transaction });
      return existingRecord ? [options] : [];
    }
    return [options];
  }

  const tenantId = getCurrentTenantIdFromState(context?.state);
  if (tenantId === null || tenantId === undefined) {
    throw tenantError(context, TENANT_CONTEXT_REQUIRED);
  }

  const repositoryContext = context;
  const writableOptions = applyTenantFilterToContext(context, collection, 'update', options);
  const writableRecord = await repository.findOne({
    ...writableOptions,
    context: repositoryContext,
    transaction,
  });
  const canReadLegacy = canReadLegacyData(tenantId, collection.options?.legacyDataTenantIds);
  const legacyFilter = appendExactTenantFilter(options?.filter, null);
  const legacyRecord = canReadLegacy
    ? await repository.findOne({
        ...options,
        filter: legacyFilter,
        context: repositoryContext,
        transaction,
      })
    : null;

  if (legacyRecord && collection.options?.allowEditingLegacyData !== true) {
    throw tenantError(context, LEGACY_RECORD_READ_ONLY);
  }

  const plans = [];
  if (writableRecord) {
    plans.push(writableOptions);
  }
  if (legacyRecord) {
    plans.push({
      ...options,
      filter: legacyFilter,
      values: appendTenantValue(omitTenantValue(options?.values), tenantId),
    });
  }

  if (plans.length === 0 && !config.allowCreateWhenMissing) {
    const unscopedRecord = await repository.findOne({
      ...options,
      filter: stripTenantFilter(options?.filter),
      context: repositoryContext,
      transaction,
    });
    if (unscopedRecord) {
      throw workflowTenantRecordUnavailableError(context);
    }
  }
  return plans;
}

/** Resolves a tenant-safe destroy and rejects direct deletion of legacy data. */
export async function resolveTenantDestroyOptions(
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  repository: any,
  options: Record<string, any>,
  transaction?: any,
) {
  const tenancyMode = collection?.options?.tenancy;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode)) {
    return options;
  }

  const tenantId = getCurrentTenantIdFromState(context?.state);
  if (tenantId === null || tenantId === undefined) {
    throw tenantError(context, TENANT_CONTEXT_REQUIRED);
  }

  const destroyOptions = applyTenantFilterToContext(context, collection, 'destroy', options);
  const writableRecord = await repository.findOne({ ...destroyOptions, context, transaction });
  const canReadLegacy = canReadLegacyData(tenantId, collection.options?.legacyDataTenantIds);
  const legacyRecord = canReadLegacy
    ? await repository.findOne({
        ...options,
        filter: appendExactTenantFilter(options?.filter, null),
        context,
        transaction,
      })
    : null;

  if (legacyRecord) {
    throw tenantError(context, LEGACY_RECORD_DELETE_REQUIRES_CLAIM);
  }
  if (!writableRecord) {
    throw workflowTenantRecordUnavailableError(context);
  }
  return destroyOptions;
}

/** Uses the request transaction when possible, otherwise owns a node transaction. */
export async function withWorkflowDataSourceTransaction<T>(
  workflow: any,
  dataSourceName: string,
  processorTransaction: any,
  callback: (transaction: any) => Promise<T>,
): Promise<T> {
  const inheritedTransaction = workflow.useDataSourceTransaction(dataSourceName, processorTransaction);
  if (inheritedTransaction) {
    return callback(inheritedTransaction);
  }

  const transaction = await workflow.useDataSourceTransaction(dataSourceName, undefined, true);
  if (!transaction) {
    return callback(undefined);
  }

  try {
    const result = await callback(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * Checks whether the workflow execution query may include legacy records without tenant markers.
 */
export function canReadLegacyExecutions(state: Record<string, any> = {}, tenantId: string | number) {
  return canReadLegacyData(tenantId, state.currentLegacyDataTenantIds);
}

/**
 * Builds the tenant filter used by workflow execution list and lookup actions.
 */
export function buildWorkflowExecutionTenantFilter(state: Record<string, any> = {}, fallback: any = null) {
  const tenantId = getCurrentTenantIdFromState(state);
  if (tenantId === null || tenantId === undefined) {
    return fallback;
  }

  if (canReadLegacyExecutions(state, tenantId)) {
    return {
      $or: [{ tenantId }, { tenantId: null }],
    };
  }

  return { tenantId };
}

function isTenantPluginEnabled(ctx: Context) {
  const pluginManagers = [ctx.tego?.pm, ctx.app?.pm];

  for (const pluginManager of pluginManagers) {
    try {
      const tenantPlugin = pluginManager?.get?.('tenant');
      if (tenantPlugin?.enabled === true) {
        return true;
      }
    } catch {
      // Ignore plugin-manager lookup failures and fall back to state checks.
    }
  }

  return false;
}

/**
 * Checks whether execution resources should be isolated by tenant context.
 */
export function shouldApplyExecutionTenantBoundary(ctx: Context) {
  const state = ctx.state || {};
  const tenantId = getCurrentTenantIdFromState(state);
  return (
    (tenantId !== null && tenantId !== undefined) || Boolean(state.currentTenancyMode) || isTenantPluginEnabled(ctx)
  );
}

/**
 * Builds the tenant filter for execution resources.
 */
export function buildExecutionTenantFilter(ctx: Context, fallback: any = NEVER_MATCH_TENANT_FILTER) {
  return buildWorkflowExecutionTenantFilter(ctx.state, shouldApplyExecutionTenantBoundary(ctx) ? fallback : null);
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

  if (!sanitizedOriginal || Reflect.ownKeys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function appendInheritedFilter(original: any, tenantIds: Array<string | number>, includeLegacyData = false) {
  const tenantFilter = buildInheritedTenantFilter(tenantIds, includeLegacyData);
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || Reflect.ownKeys(sanitizedOriginal).length === 0) {
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

/**
 * Reads the effective tenant ID from a workflow repository context state.
 */
export function getCurrentTenantIdFromState(state: TenantFilterContext['state']) {
  return state?.currentTenant?.id ?? state?.currentTenantId;
}

function buildTenantParams(actionName: string, params: any, state: TenantFilterContext['state'], tenancyMode?: string) {
  const tenantId = getCurrentTenantIdFromState(state);
  if (tenantId === null || tenantId === undefined) {
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
      throw new Error('Tenant context is required for tenant isolated workflow create operations');
    }

    return {};
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

/**
 * Returns workflow repository options with tenant filters or values merged in.
 */
export function applyTenantFilterToContext<TOptions extends Record<string, any>>(
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  actionName: string,
  options: TOptions,
) {
  const tenancyMode = collection?.options?.tenancy;
  if (!TENANT_ENABLED_MODES.includes(tenancyMode)) {
    return options;
  }

  const state = {
    ...context?.state,
    currentTenancyMode: tenancyMode,
    currentLegacyDataTenantIds:
      context?.state?.workflowExcludeLegacyData === true
        ? []
        : (collection?.options?.legacyDataTenantIds ?? context?.state?.currentLegacyDataTenantIds),
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

/**
 * Loads descendant tenant IDs for inherited workflow execution visibility.
 */
export async function getDescendantTenantIds(
  db: any,
  tenantId: string,
  options: { enabledOnly?: boolean } = {},
): Promise<string[]> {
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
      ...(options.enabledOnly ? { enabled: true } : {}),
      ...buildPathPrefixFilter(path),
    },
    fields: ['id', 'path'],
  });

  return descendants
    .filter((tenant: any) => tenant.get('id') !== tenantId && tenant.get('path')?.startsWith(path))
    .map((tenant: any) => tenant.get('id'));
}
