import { TENANT_ENABLED_MODES } from '../constants';
import { translateTenantError } from '../locale';

const LEGACY_CLAIM_GUARD_LISTENER = Symbol.for('@tachybase/module-tenant/legacy-claim-guard-listener');
const LEGACY_CLAIM_DATA_SOURCE_ADD = Symbol.for('@tachybase/module-tenant/legacy-claim-data-source-add');

function hasSameTenantId(left: unknown, right: unknown) {
  return left !== null && left !== undefined && right !== null && right !== undefined && `${left}` === `${right}`;
}

function throwRecordUnavailable(context: any): never {
  const message = translateTenantError(context, 'recordUnavailable');
  if (typeof context?.throw === 'function') {
    context.throw(404, message);
  }

  const error = new Error(message) as Error & { status?: number };
  error.status = 404;
  throw error;
}

/**
 * Serializes null-to-tenant ownership changes made by resource updates.
 */
export async function guardLegacyTenantClaimUpdate(db: any, model: any, options: any = {}) {
  if (!model?.changed?.('tenantId')) {
    return;
  }

  const collection = db.modelCollection?.get?.(model.constructor) || db.getCollection?.(model.constructor?.name);
  if (
    !collection ||
    !TENANT_ENABLED_MODES.includes(collection.options?.tenancy as any) ||
    collection.options?.allowEditingLegacyData !== true
  ) {
    return;
  }

  const context = options.context;
  const currentTenantId = context?.state?.currentTenant?.id ?? context?.state?.currentTenantId;
  if (currentTenantId === null || currentTenantId === undefined) {
    return;
  }

  const previousTenantId = model.previous('tenantId');
  const nextTenantId = model.get('tenantId');
  const canReadLegacyData = (collection.options?.legacyDataTenantIds || []).some((tenantId: string | number) =>
    hasSameTenantId(tenantId, currentTenantId),
  );
  if (previousTenantId !== null || !hasSameTenantId(nextTenantId, currentTenantId) || !canReadLegacyData) {
    throwRecordUnavailable(context);
  }

  const transaction = options.transaction;
  if (!transaction) {
    throwRecordUnavailable(context);
  }

  const targetKeys = Array.isArray(collection.filterTargetKey)
    ? collection.filterTargetKey
    : [collection.filterTargetKey || model.constructor.primaryKeyAttribute];
  const where = Object.fromEntries(targetKeys.map((targetKey: string) => [targetKey, model.get(targetKey)]));
  const persistedRecord = await model.constructor.findOne({
    attributes: ['tenantId'],
    where,
    transaction,
    lock: transaction.LOCK?.UPDATE ?? true,
  });

  if (!persistedRecord || persistedRecord.get('tenantId') !== null) {
    throwRecordUnavailable(context);
  }
}

export function registerLegacyTenantClaimGuard(db: any) {
  if (!db?.on || db[LEGACY_CLAIM_GUARD_LISTENER]) {
    return;
  }

  const listener = (model: any, options: any) => guardLegacyTenantClaimUpdate(db, model, options);
  db.on('beforeUpdate', listener);
  Object.defineProperty(db, LEGACY_CLAIM_GUARD_LISTENER, {
    configurable: true,
    value: listener,
  });
}

export function registerLegacyTenantClaimGuardsForDataSources(dataSourceManager: any) {
  if (!dataSourceManager) {
    return;
  }

  for (const dataSource of dataSourceManager.dataSources?.values?.() || []) {
    registerLegacyTenantClaimGuard(dataSource?.collectionManager?.db);
  }

  if (
    typeof dataSourceManager.add !== 'function' ||
    dataSourceManager[LEGACY_CLAIM_DATA_SOURCE_ADD] === dataSourceManager.add
  ) {
    return;
  }

  const originalAdd = dataSourceManager.add;
  const wrappedAdd = async function (this: any, dataSource: any, options?: any) {
    registerLegacyTenantClaimGuard(dataSource?.collectionManager?.db);
    const result = await originalAdd.call(this, dataSource, options);
    registerLegacyTenantClaimGuard(dataSource?.collectionManager?.db);
    return result;
  };

  dataSourceManager.add = wrappedAdd;
  Object.defineProperty(dataSourceManager, LEGACY_CLAIM_DATA_SOURCE_ADD, {
    configurable: true,
    value: wrappedAdd,
  });
}
