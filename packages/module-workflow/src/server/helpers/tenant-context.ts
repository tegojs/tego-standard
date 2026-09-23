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

type WorkflowTenantDiagnostic = {
  reason:
    | 'TENANT_RECORD_NOT_FOUND'
    | 'TENANT_RECORD_INACCESSIBLE'
    | 'TENANT_ASSOCIATION_RECORD_NOT_FOUND'
    | 'TENANT_ASSOCIATION_RECORD_INACCESSIBLE'
    | 'TENANT_ASSOCIATION_RECORD_LEGACY_INACCESSIBLE'
    | 'TENANT_RECORD_FILTER_CHANGED'
    | 'TENANT_RECORD_FILTER_UNRESOLVED'
    | 'TENANT_RECORD_NOT_FOUND_OR_FILTER_CHANGED'
    | 'TENANT_RECORD_LEGACY_INACCESSIBLE'
    | 'TENANT_RECORD_LEGACY_READ_ONLY'
    | 'TENANT_RECORD_BECAME_LEGACY'
    | 'TENANT_RETRY_CONTEXT_MISMATCH'
    | 'TENANT_RETRY_CONTEXT_UNAVAILABLE';
  operation?: 'update' | 'updateOrCreate' | 'destroy' | 'associate' | 'retry';
  collection?: string;
  executionId?: string | number;
  executionTenantId?: string | number | null;
  originalTenantId?: string | number;
  recordKey?: string | number;
  recordKeyField?: string;
  lookup?: string;
  currentTenantId?: string | number;
  recordTenantId?: string | number | null;
  legacyDataReadable?: boolean;
  legacyDataEditable?: boolean;
  sourceCollection?: string;
  association?: string;
  targetCollection?: string;
  filterPath?: string;
  filterValueType?: string;
};

const TENANT_DIAGNOSTIC_OPERATION_KEYS = {
  update: 'TENANT_DIAGNOSTIC_OPERATION_UPDATE',
  updateOrCreate: 'TENANT_DIAGNOSTIC_OPERATION_UPDATE_OR_CREATE',
  destroy: 'TENANT_DIAGNOSTIC_OPERATION_DELETE',
  associate: 'TENANT_DIAGNOSTIC_OPERATION_ASSOCIATION',
  retry: 'TENANT_DIAGNOSTIC_OPERATION_RETRY',
} as const;

const TENANT_DIAGNOSTIC_OPERATION_DEFAULTS = {
  update: 'update',
  updateOrCreate: 'update or create',
  destroy: 'delete',
  associate: 'association validation',
  retry: 'retry',
} as const;

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

function getCollectionName(collection: TenantFilterCollection) {
  return collection?.name || collection?.options?.name || collection?.model?.name || 'unknown';
}

function getCollectionTargetKey(collection: TenantFilterCollection) {
  return collection?.filterTargetKey || collection?.options?.filterTargetKey || 'id';
}

function truncateTenantDiagnosticText(value: string, maxLength = 512) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
}

function isDiagnosticRecordKey(value: any): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function getDiagnosticRecordKey(collection: TenantFilterCollection, options: Record<string, any>, record?: any) {
  const targetKey = getCollectionTargetKey(collection);
  const targetKeyFilter = getDiagnosticTargetKeyFilter(collection, options);
  if (isDiagnosticRecordKey(targetKeyFilter?.value)) {
    return targetKeyFilter.value;
  }

  const recordKey = getRecordValue(record, targetKey);
  return isDiagnosticRecordKey(recordKey) ? recordKey : undefined;
}

function findDiagnosticTargetKeyFilter(
  value: any,
  targetKey: string,
  path = '',
  depth = 0,
  seen = new WeakSet<object>(),
): { path: string; value: any } | undefined {
  if (depth > 10 || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 100); index += 1) {
      const match = findDiagnosticTargetKeyFilter(value[index], targetKey, `${path}[${index}]`, depth + 1, seen);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  for (const [key, filterValue] of Object.entries(value).slice(0, 100)) {
    const filterPath = path ? `${path}.${key}` : key;
    if (key === targetKey) {
      if (filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue) && '$eq' in filterValue) {
        return { path: `${filterPath}.$eq`, value: filterValue.$eq };
      }
      return { path: filterPath, value: filterValue };
    }
    if (!key.startsWith('$')) {
      continue;
    }
    const match = findDiagnosticTargetKeyFilter(filterValue, targetKey, filterPath, depth + 1, seen);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function getDiagnosticTargetKeyFilter(
  collection: TenantFilterCollection,
  options: Record<string, any>,
): { path: string; value: any } | undefined {
  if (isDiagnosticRecordKey(options?.filterByTk)) {
    return { path: 'filterByTk', value: options.filterByTk };
  }

  const filterMatch = findDiagnosticTargetKeyFilter(options?.filter, getCollectionTargetKey(collection));
  if (filterMatch) {
    return filterMatch;
  }

  if (Object.prototype.hasOwnProperty.call(options || {}, 'filterByTk')) {
    return { path: 'filterByTk', value: options.filterByTk };
  }
  return undefined;
}

function getUnresolvedDiagnosticTargetKeyFilter(
  collection: TenantFilterCollection,
  options: Record<string, any>,
): { path: string; valueType: string } | undefined {
  const match = getDiagnosticTargetKeyFilter(collection, options);
  if (!match || (match.value !== null && match.value !== undefined)) {
    return undefined;
  }
  return { path: match.path, valueType: match.value === null ? 'null' : 'undefined' };
}

function getDiagnosticLookup(collection: TenantFilterCollection, options: Record<string, any>) {
  if (isDiagnosticRecordKey(options?.filterByTk)) {
    return `filterByTk=${truncateTenantDiagnosticText(String(options.filterByTk), 256)}`;
  }
  if (Array.isArray(options?.filterByTk)) {
    return `filterByTkCount=${options.filterByTk.length}`;
  }
  const filter = stripTenantFilter(options?.filter);
  if (!filter || typeof filter !== 'object') {
    return undefined;
  }
  const fields = Reflect.ownKeys(filter)
    .filter((key): key is string => typeof key === 'string')
    .slice(0, 20)
    .map((key) => truncateTenantDiagnosticText(key, 64));
  const suffix = Reflect.ownKeys(filter).length > fields.length ? ',...[truncated]' : '';
  return `filterFields=${fields.join(',')}${suffix}`;
}

function translateTenantDiagnostic(context: any, key: string, defaultValue: string, values: Record<string, string>) {
  if (typeof context?.t !== 'function') {
    return defaultValue;
  }
  const translated = context.t(key, { ns: 'workflow', defaultValue, ...values });
  return typeof translated === 'string' && translated !== key ? translated : defaultValue;
}

function formatTenantDiagnosticValue(value: unknown) {
  if (value === undefined) {
    return 'unknown';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'string') {
    return truncateTenantDiagnosticText(String(value));
  }
  const serialized = JSON.stringify(value);
  return truncateTenantDiagnosticText(serialized.slice(1, -1));
}

function quoteTenantDiagnosticValue(value: unknown) {
  return `"${formatTenantDiagnosticValue(value)}"`;
}

function formatTenantDiagnosticTarget(collection: unknown, recordKeyField: unknown) {
  return formatTenantDiagnosticValue(
    [collection, recordKeyField].filter((value) => value !== undefined && value !== null).join('.') || 'unknown',
  );
}

function formatTenantDiagnosticSummary(context: any, diagnostic: WorkflowTenantDiagnostic) {
  const operation = diagnostic.operation || 'update';
  const operationLabel = translateTenantDiagnostic(
    context,
    TENANT_DIAGNOSTIC_OPERATION_KEYS[operation],
    TENANT_DIAGNOSTIC_OPERATION_DEFAULTS[operation],
    {},
  );
  const target = formatTenantDiagnosticTarget(
    diagnostic.targetCollection || diagnostic.collection,
    diagnostic.recordKeyField,
  );
  const values = {
    operation: operationLabel,
    collection: formatTenantDiagnosticValue(diagnostic.collection),
    recordKeyField: formatTenantDiagnosticValue(diagnostic.recordKeyField),
    recordTarget: target,
    recordKey: formatTenantDiagnosticValue(diagnostic.recordKey),
    currentTenantId: formatTenantDiagnosticValue(diagnostic.currentTenantId),
    recordTenantId: formatTenantDiagnosticValue(diagnostic.recordTenantId),
    sourceCollection: formatTenantDiagnosticValue(diagnostic.sourceCollection),
    association: formatTenantDiagnosticValue(diagnostic.association),
    targetCollection: formatTenantDiagnosticValue(diagnostic.targetCollection),
    lookup: formatTenantDiagnosticValue(diagnostic.lookup),
    filterPath: formatTenantDiagnosticValue(diagnostic.filterPath),
    filterValueType: formatTenantDiagnosticValue(diagnostic.filterValueType),
    executionId: formatTenantDiagnosticValue(diagnostic.executionId),
    originalTenantId: formatTenantDiagnosticValue(diagnostic.originalTenantId),
  };

  switch (diagnostic.reason) {
    case 'TENANT_RECORD_NOT_FOUND':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_NOT_FOUND',
        `Workflow ${operationLabel} failed. Reason: target record ${quoteTenantDiagnosticValue(target)}=${values.recordKey} does not exist or was deleted before this node ran. The target record was not modified.`,
        values,
      );
    case 'TENANT_RECORD_INACCESSIBLE':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_INACCESSIBLE',
        `Workflow ${operationLabel} failed. Reason: target record ${quoteTenantDiagnosticValue(target)}=${values.recordKey} exists and belongs to tenant ${quoteTenantDiagnosticValue(diagnostic.recordTenantId)}; current tenant ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)} is not allowed to access it. The target record was not modified.`,
        values,
      );
    case 'TENANT_RECORD_LEGACY_INACCESSIBLE':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_LEGACY_INACCESSIBLE',
        `Workflow ${operationLabel} failed. Reason: target record ${quoteTenantDiagnosticValue(target)}=${values.recordKey} exists but is unassigned legacy data. Current tenant ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)} is not configured to access legacy data in collection ${quoteTenantDiagnosticValue(diagnostic.collection)}. The target record was not modified.`,
        values,
      );
    case 'TENANT_ASSOCIATION_RECORD_NOT_FOUND':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_ASSOCIATION_RECORD_NOT_FOUND',
        `Workflow association validation failed. Reason: field ${quoteTenantDiagnosticValue(diagnostic.association)} on collection ${quoteTenantDiagnosticValue(diagnostic.sourceCollection)} references record ${quoteTenantDiagnosticValue(target)}=${values.recordKey}, but that related record does not exist or has been deleted. The association write was rejected.`,
        values,
      );
    case 'TENANT_ASSOCIATION_RECORD_INACCESSIBLE':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_ASSOCIATION_RECORD_INACCESSIBLE',
        `Workflow association validation failed. Reason: field ${quoteTenantDiagnosticValue(diagnostic.association)} on collection ${quoteTenantDiagnosticValue(diagnostic.sourceCollection)} references record ${quoteTenantDiagnosticValue(target)}=${values.recordKey}. The record exists and belongs to tenant ${quoteTenantDiagnosticValue(diagnostic.recordTenantId)}; current tenant ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)} is not allowed to access it. The association write was rejected.`,
        values,
      );
    case 'TENANT_ASSOCIATION_RECORD_LEGACY_INACCESSIBLE':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_ASSOCIATION_RECORD_LEGACY_INACCESSIBLE',
        `Workflow association validation failed. Reason: field ${quoteTenantDiagnosticValue(diagnostic.association)} on collection ${quoteTenantDiagnosticValue(diagnostic.sourceCollection)} references record ${quoteTenantDiagnosticValue(target)}=${values.recordKey}. The related record exists but is unassigned legacy data, and current tenant ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)} is not configured to access legacy data in collection ${quoteTenantDiagnosticValue(diagnostic.targetCollection)}. The association write was rejected.`,
        values,
      );
    case 'TENANT_RECORD_FILTER_CHANGED':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_FILTER_CHANGED',
        `Workflow ${operationLabel} failed before modifying data: record ${quoteTenantDiagnosticValue(target)}=${values.recordKey} exists and is accessible, but it no longer matches filter ${quoteTenantDiagnosticValue(diagnostic.lookup)}. The data or filter may have changed while the node was running.`,
        values,
      );
    case 'TENANT_RECORD_FILTER_UNRESOLVED':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_FILTER_UNRESOLVED',
        `Workflow ${operationLabel} failed. Reason: the target record key (${quoteTenantDiagnosticValue(target)}) is ${values.filterValueType}, so the system cannot determine which record to ${operationLabel}. Check the value at filter ${quoteTenantDiagnosticValue(diagnostic.filterPath)}; if it comes from a workflow variable, check the corresponding upstream output. No ${operationLabel} operation was performed on a target record.`,
        values,
      );
    case 'TENANT_RECORD_NOT_FOUND_OR_FILTER_CHANGED':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_NOT_FOUND_OR_FILTER_CHANGED',
        `Workflow ${operationLabel} failed before modifying data: no record matches filter ${quoteTenantDiagnosticValue(diagnostic.lookup)}, and the target record key could not be determined. The record may have been deleted or a workflow variable used by the filter may have changed. Current tenant: ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)}.`,
        values,
      );
    case 'TENANT_RECORD_LEGACY_READ_ONLY':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_LEGACY_READ_ONLY',
        `Workflow ${operationLabel} failed before modifying data: record ${quoteTenantDiagnosticValue(target)}=${values.recordKey} is unassigned legacy data and is read-only for current tenant ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)}. Enable legacy-data editing for this collection before retrying.`,
        values,
      );
    case 'TENANT_RECORD_BECAME_LEGACY':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RECORD_BECAME_LEGACY',
        `Workflow ${operationLabel} failed before modifying data: record ${quoteTenantDiagnosticValue(target)}=${values.recordKey} became unassigned legacy data while the node was running. Retry after confirming the record's tenant assignment.`,
        values,
      );
    case 'TENANT_RETRY_CONTEXT_MISMATCH':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RETRY_CONTEXT_MISMATCH',
        `Workflow retry was blocked before execution: execution ${values.executionId} was created under tenant ${quoteTenantDiagnosticValue(diagnostic.originalTenantId)}, but the current tenant is ${quoteTenantDiagnosticValue(diagnostic.currentTenantId)}. Retry it from the original tenant.`,
        values,
      );
    case 'TENANT_RETRY_CONTEXT_UNAVAILABLE':
      return translateTenantDiagnostic(
        context,
        'TENANT_DIAGNOSTIC_RETRY_CONTEXT_UNAVAILABLE',
        `Workflow retry was blocked before execution: execution ${values.executionId} has no saved tenant context, so its tenant cannot be determined safely. Start a new execution or restore the original tenant context before retrying.`,
        values,
      );
  }
}

function appendTenantDiagnostic(context: any, error: Error, diagnostic: WorkflowTenantDiagnostic) {
  const boundedDiagnostic = Object.fromEntries(
    Object.entries(diagnostic)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'string' ? truncateTenantDiagnosticText(value) : value]),
  ) as WorkflowTenantDiagnostic;
  const diagnosticLine = `[tenant-diagnostic] ${JSON.stringify(boundedDiagnostic)}`;
  const stackSummary = formatTenantDiagnosticSummary(context, boundedDiagnostic);
  const stackFrames = error.stack?.includes('\n') ? error.stack.slice(error.stack.indexOf('\n')) : '';
  error.stack = `${error.name}: ${stackSummary}\n${diagnosticLine}${stackFrames}`;
  Object.defineProperty(error, 'tenantDiagnostic', {
    configurable: true,
    value: boundedDiagnostic,
  });
  return error;
}

export function workflowTenantRecordUnavailableError(context: any, diagnostic?: WorkflowTenantDiagnostic) {
  const error = tenantError(context, RECORD_UNAVAILABLE);
  return diagnostic ? appendTenantDiagnostic(context, error, diagnostic) : error;
}

export async function workflowTenantRecordMutationMissError(
  context: TenantFilterContext,
  collection: TenantFilterCollection,
  repository: any,
  options: Record<string, any>,
  transaction?: any,
  operation: WorkflowTenantDiagnostic['operation'] = 'update',
) {
  const targetKey = getCollectionTargetKey(collection);
  const unresolvedTargetKeyFilter = getUnresolvedDiagnosticTargetKeyFilter(collection, options);
  let recordKey = getDiagnosticRecordKey(collection, options);
  const lookupOptions = isDiagnosticRecordKey(recordKey)
    ? { filter: { [targetKey]: recordKey } }
    : { filter: stripTenantFilter(options?.filter) };
  const unscopedRecord = await repository.findOne({ ...lookupOptions, context, transaction });
  recordKey ??= getDiagnosticRecordKey(collection, options, unscopedRecord);

  let reason: WorkflowTenantDiagnostic['reason'];
  let recordTenantId: string | number | null | undefined;
  if (!unscopedRecord) {
    reason = unresolvedTargetKeyFilter
      ? 'TENANT_RECORD_FILTER_UNRESOLVED'
      : isDiagnosticRecordKey(recordKey)
        ? 'TENANT_RECORD_NOT_FOUND'
        : 'TENANT_RECORD_NOT_FOUND_OR_FILTER_CHANGED';
  } else {
    recordTenantId = getRecordValue(unscopedRecord, 'tenantId');
    const tenantId = getCurrentTenantIdFromState(context?.state);
    const legacyDataReadable =
      recordTenantId === null && canReadLegacyData(tenantId, collection.options?.legacyDataTenantIds);
    const legacyDataEditable = legacyDataReadable && collection.options?.allowEditingLegacyData === true;
    if (recordTenantId === null && legacyDataReadable) {
      reason = legacyDataEditable ? 'TENANT_RECORD_BECAME_LEGACY' : 'TENANT_RECORD_LEGACY_READ_ONLY';
      return workflowTenantRecordUnavailableError(context, {
        reason,
        operation,
        collection: getCollectionName(collection),
        recordKey,
        recordKeyField: targetKey,
        lookup: getDiagnosticLookup(collection, options),
        currentTenantId: tenantId,
        recordTenantId,
        legacyDataReadable,
        legacyDataEditable,
      });
    }

    const writableOptions = applyTenantFilterToContext(context, collection, 'update', lookupOptions);
    const writableRecord = await repository.findOne({ ...writableOptions, context, transaction });
    reason = writableRecord
      ? 'TENANT_RECORD_FILTER_CHANGED'
      : recordTenantId === null
        ? 'TENANT_RECORD_LEGACY_INACCESSIBLE'
        : 'TENANT_RECORD_INACCESSIBLE';
  }

  return workflowTenantRecordUnavailableError(context, {
    reason,
    operation,
    collection: getCollectionName(collection),
    recordKey,
    recordKeyField: targetKey,
    lookup: getDiagnosticLookup(collection, options),
    currentTenantId: getCurrentTenantIdFromState(context?.state),
    recordTenantId,
    filterPath: unresolvedTargetKeyFilter?.path,
    filterValueType: unresolvedTargetKeyFilter?.valueType,
  });
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
  associationContext?: { sourceCollection: string; association: string },
) {
  const referenceOptions = {
    filter: { [targetKey]: targetKeyValue },
  };
  const options = applyTenantFilterToContext(context, collection, 'get', referenceOptions);
  const record = await repository.findOne({ ...options, context, transaction });
  if (!record) {
    const unscopedRecord = await repository.findOne({ ...referenceOptions, context, transaction });
    const recordTenantId = unscopedRecord ? getRecordValue(unscopedRecord, 'tenantId') : undefined;
    throw workflowTenantRecordUnavailableError(context, {
      reason: !unscopedRecord
        ? 'TENANT_ASSOCIATION_RECORD_NOT_FOUND'
        : recordTenantId === null
          ? 'TENANT_ASSOCIATION_RECORD_LEGACY_INACCESSIBLE'
          : 'TENANT_ASSOCIATION_RECORD_INACCESSIBLE',
      operation: 'associate',
      sourceCollection: associationContext?.sourceCollection,
      association: associationContext?.association,
      targetCollection: getCollectionName(collection),
      recordKey: targetKeyValue,
      recordKeyField: targetKey,
      lookup: getDiagnosticLookup(collection, referenceOptions),
      currentTenantId: getCurrentTenantIdFromState(context?.state),
      recordTenantId,
    });
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
        { sourceCollection: getCollectionName(collection), association: associationPath },
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
            { sourceCollection: getCollectionName(collection), association: associationPath },
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
          { sourceCollection: getCollectionName(collection), association: associationPath },
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
  config: { allowCreateWhenMissing?: boolean; operation?: 'update' | 'updateOrCreate' } = {},
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
      const recordTenantId = getRecordValue(unscopedRecord, 'tenantId');
      throw workflowTenantRecordUnavailableError(context, {
        reason: recordTenantId === null ? 'TENANT_RECORD_LEGACY_INACCESSIBLE' : 'TENANT_RECORD_INACCESSIBLE',
        operation: config.operation || 'update',
        collection: getCollectionName(collection),
        recordKey: getDiagnosticRecordKey(collection, options, unscopedRecord),
        recordKeyField: getCollectionTargetKey(collection),
        lookup: getDiagnosticLookup(collection, options),
        currentTenantId: tenantId,
        recordTenantId,
      });
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
    throw await workflowTenantRecordMutationMissError(context, collection, repository, options, transaction, 'destroy');
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
