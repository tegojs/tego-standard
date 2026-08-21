import { Plugin, uid } from '@tego/server';

import { NAMESPACE, TENANT_IMPERSONATION_SNIPPET } from '../constants';
import availableTenants from './actions/available-tenants';
import currentTenant from './actions/current-tenant';
import switchTenant from './actions/switch-tenant';
import tenantsCollection from './collections/tenants';
import tenantUsersCollection from './collections/tenantUsers';
import usersCollection from './collections/users';
import { TENANT_ENABLED_MODES } from './constants';
import { ensureTenantIdField } from './helpers/ensure-tenant-id-field';
import { getCollectionTenancyMode } from './helpers/isTenantScopedCollection';
import applyTenantFilter, {
  applyTenantFilterToContext,
  applyUnassignedTenantReadFilter,
  isTenantReadAction,
} from './helpers/tenant-filter';
import { moveTenantRecords } from './helpers/tenant-move';
import { buildPath, getDescendantIds, getDescendantTenants, wouldCreateCycle } from './helpers/tenant-tree';
import { enUS, translateTenantError, zhCN } from './locale';
import setCurrentTenant from './middlewares/setCurrentTenant';

export interface TenantPluginConfig {
  name: string;
}

const ASSOCIATION_TARGET_WRITE_ACTIONS = new Set(['add', 'remove', 'set', 'toggle', 'move']);
const ROOT_ASSOCIATION_VALUE_ACTIONS = new Set(['create', 'update']);

function getAssociationCollections(db: any, resourceName?: string) {
  const [sourceName, associationName] = resourceName?.split('.') || [];
  if (!sourceName || !associationName) {
    return null;
  }

  const sourceCollection = db.getCollection(sourceName);
  const targetName = sourceCollection?.getField?.(associationName)?.target;
  const targetCollection = targetName ? db.getCollection(targetName) : db.getCollection(resourceName);
  if (!sourceCollection || !targetCollection) {
    return null;
  }

  return { sourceCollection, targetCollection };
}

function getAssociationTargetKeys(actionName: string, params: Record<string, any> = {}) {
  const rawValues =
    actionName === 'move'
      ? [params.sourceId, params.targetId]
      : (params.values ?? params.filterByTks ?? params.filterByTk);
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];

  return values
    .map((value) => (Array.isArray(value) ? value[0] : value))
    .filter((value) => value !== undefined && value !== null && value !== '');
}

async function findTenantRecord(
  ctx: any,
  collection: any,
  filterByTk: any,
  actionName: 'get' | 'update',
  filterKey?: string,
  repository = collection?.repository,
) {
  const options = applyTenantFilterToContext(ctx, collection, actionName, {
    ...(filterKey ? { filter: { [filterKey]: filterByTk } } : { filterByTk }),
    context: ctx,
  });
  return repository.findOne(options);
}

async function assertTenantRecordAccess(
  ctx: any,
  collection: any,
  filterByTk: any,
  actionName: 'get' | 'update',
  filterKey?: string,
) {
  const record = await findTenantRecord(ctx, collection, filterByTk, actionName, filterKey);
  if (!record) {
    ctx.throw(404, translateTenantError(ctx, 'recordUnavailable'));
  }
}

function hasTargetKey(value: any) {
  return value !== undefined && value !== null && value !== '';
}

function getAssociationTargetCollection(db: any, association: any) {
  return db.modelCollection?.get?.(association.target) || db.getCollection(association.target?.name);
}

function requireTenantContext(ctx: any) {
  if (!hasTargetKey(ctx.state?.currentTenant?.id ?? ctx.state?.currentTenantId)) {
    ctx.throw(403, translateTenantError(ctx, 'tenantContextRequired'));
  }
}

function getAssociationValueUpdatePaths(ctx: any) {
  const paths = ctx.action?.params?.updateAssociationValues;
  return new Set<string>((Array.isArray(paths) ? paths : [paths]).filter((path) => typeof path === 'string' && path));
}

function getRecordValue(record: any, key: string) {
  return typeof record?.get === 'function' ? record.get(key) : record?.[key];
}

async function findWritableRootRecord(ctx: any, collection: any, repository: any) {
  const filterByTk = ctx.action?.params?.filterByTk;
  const actionName = ctx.action?.actionName;
  if (!hasTargetKey(filterByTk) || !['update', 'destroy'].includes(actionName)) {
    return undefined;
  }

  const currentTenantId = ctx.state?.currentTenant?.id ?? ctx.state?.currentTenantId;
  const canReadLegacyData = (collection.options?.legacyDataTenantIds || []).some(
    (tenantId: string | number) => `${tenantId}` === `${currentTenantId}`,
  );
  if (actionName === 'destroy' && !canReadLegacyData) {
    return undefined;
  }

  const writableRecord = await findTenantRecord(ctx, collection, filterByTk, 'update', undefined, repository);
  if (writableRecord || !canReadLegacyData) {
    return writableRecord;
  }

  const readableRecord = await findTenantRecord(ctx, collection, filterByTk, 'get', undefined, repository);
  if (readableRecord && getRecordValue(readableRecord, 'tenantId') === null) {
    ctx.throw(403, translateTenantError(ctx, 'legacyRecordReadOnly'));
  }

  return undefined;
}

function getAssociationValueTargetKeys(value: any, targetKey: string) {
  const targetKeys = [];
  for (const item of Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]) {
    const targetKeyValue =
      typeof item === 'string' || typeof item === 'number' ? item : getRecordValue(item, targetKey);
    if (!hasTargetKey(targetKeyValue)) {
      return null;
    }
    targetKeys.push(`${targetKeyValue}`);
  }
  return targetKeys.sort();
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

// Expanded form values can contain already-persisted relations. Remove only the exact no-op graph before tenant checks.
async function hasUnchangedAssociationValues(
  db: any,
  sourceRecord: any,
  association: any,
  associationValue: any,
  associationPath: string,
  valueUpdatePaths: Set<string>,
  transaction?: any,
) {
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

  const requestedTargetKeys = getAssociationValueTargetKeys(associationValue, targetKey);
  if (!requestedTargetKeys) {
    return false;
  }

  const getAccessor = association.accessors?.get;
  if (!getAccessor || typeof sourceRecord[getAccessor] !== 'function') {
    return false;
  }
  const existingAssociationValue = await sourceRecord[getAccessor]({ transaction });

  const existingTargetKeys = getAssociationValueTargetKeys(existingAssociationValue, targetKey);
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

    if (valueUpdatePaths.has(associationPath)) {
      for (const [key, requestedFieldValue] of Object.entries(requestedValue)) {
        if (key in targetCollection.model.associations || key === throughModelName) {
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
      const nestedAssociationPath = `${associationPath}.${nestedAssociationName}`;
      if (
        !(await hasUnchangedAssociationValues(
          db,
          existingRecord,
          nestedAssociation,
          requestedValue[nestedAssociationName],
          nestedAssociationPath,
          valueUpdatePaths,
          transaction,
        ))
      ) {
        return false;
      }
    }
  }

  return true;
}

async function guardTenantAssociationValues(
  ctx: any,
  db: any,
  collection: any,
  values: any,
  pathPrefix = '',
  valueUpdatePaths = getAssociationValueUpdatePaths(ctx),
  sourceRecord?: any,
): Promise<any> {
  if (!values || !collection?.model?.associations) {
    return values;
  }

  if (Array.isArray(values)) {
    const guardedValues = [];
    for (const value of values) {
      guardedValues.push(await guardTenantAssociationValues(ctx, db, collection, value, pathPrefix, valueUpdatePaths));
    }
    return guardedValues;
  }

  if (typeof values !== 'object') {
    return values;
  }

  const explicitBelongsToForeignKeys = new Set<string>();
  for (const [associationName, association] of Object.entries<any>(collection.model.associations)) {
    if (
      association.associationType === 'BelongsTo' &&
      typeof association.foreignKey === 'string' &&
      associationName in values
    ) {
      explicitBelongsToForeignKeys.add(association.foreignKey);
    }
  }

  for (const [associationName, association] of Object.entries<any>(collection.model.associations)) {
    const isBelongsTo = association.associationType === 'BelongsTo';
    const associationForeignKey = isBelongsTo ? association.foreignKey : null;
    const associationPath = pathPrefix ? `${pathPrefix}.${associationName}` : associationName;
    const targetKey = collection.getField?.(associationName)?.targetKey || association.targetKey || 'id';
    const targetCollection = getAssociationTargetCollection(db, association);
    if (!targetCollection) {
      continue;
    }
    const targetTenancyMode = getCollectionTenancyMode(targetCollection);
    const tenantAwareTarget = TENANT_ENABLED_MODES.includes(targetTenancyMode as any);
    const hadAssociationValue = associationName in values;
    let hasAssociationValue = hadAssociationValue;
    if (
      hasAssociationValue &&
      tenantAwareTarget &&
      (await hasUnchangedAssociationValues(
        db,
        sourceRecord,
        association,
        values[associationName],
        associationPath,
        valueUpdatePaths,
        ctx.transaction,
      ))
    ) {
      delete values[associationName];
      hasAssociationValue = false;
    }
    const hasForeignKeyValue =
      typeof associationForeignKey === 'string' &&
      associationForeignKey in values &&
      (hadAssociationValue || !explicitBelongsToForeignKeys.has(associationForeignKey));
    if (!hasAssociationValue && !hasForeignKeyValue) {
      continue;
    }

    const existingTargetAction = valueUpdatePaths.has(associationPath) ? 'update' : 'get';

    const guardValue = async (value: any): Promise<any> => {
      if (value === undefined || value === null) {
        return value;
      }

      if (typeof value === 'string' || typeof value === 'number') {
        if (tenantAwareTarget) {
          requireTenantContext(ctx);
          await assertTenantRecordAccess(ctx, targetCollection, value, existingTargetAction, targetKey);
        }
        return value;
      }

      if (typeof value !== 'object') {
        return value;
      }

      const targetKeyValue =
        (typeof value.get === 'function' ? value.get(targetKey) : value[targetKey]) ?? value[targetKey];
      let guardedValue = value;
      let targetRecord;

      if (tenantAwareTarget) {
        requireTenantContext(ctx);

        if (hasTargetKey(targetKeyValue)) {
          const currentTenantRecord = await findTenantRecord(
            ctx,
            targetCollection,
            targetKeyValue,
            existingTargetAction,
            targetKey,
          );
          targetRecord = currentTenantRecord;

          if (!currentTenantRecord) {
            const existingRecord = await targetCollection.repository.findOne({
              filter: { [targetKey]: targetKeyValue },
              context: ctx,
            });
            targetRecord = existingRecord;
            if (existingRecord) {
              ctx.throw(404, translateTenantError(ctx, 'recordUnavailable'));
            }
          }

          if (existingTargetAction === 'update') {
            guardedValue = applyTenantFilterToContext(
              ctx,
              targetCollection,
              currentTenantRecord ? 'update' : 'create',
              {
                values: value,
              },
            ).values;
          }
        } else {
          guardedValue = applyTenantFilterToContext(ctx, targetCollection, 'create', { values: value }).values;
        }
      } else if (hasTargetKey(targetKeyValue)) {
        targetRecord = await targetCollection.repository.findOne({
          filter: { [targetKey]: targetKeyValue },
          context: ctx,
        });
      }

      return guardTenantAssociationValues(
        ctx,
        db,
        targetCollection,
        guardedValue,
        associationPath,
        valueUpdatePaths,
        targetRecord,
      );
    };

    if (hasAssociationValue) {
      const associationValue = values[associationName];
      if (Array.isArray(associationValue)) {
        const guardedAssociationValues = [];
        for (const value of associationValue) {
          guardedAssociationValues.push(await guardValue(value));
        }
        values[associationName] = guardedAssociationValues;
      } else {
        values[associationName] = await guardValue(associationValue);
      }
    }

    const foreignKeyUnchanged =
      hasForeignKeyValue &&
      `${getRecordValue(sourceRecord, associationForeignKey)}` === `${values[associationForeignKey]}`;
    if (hasForeignKeyValue && !foreignKeyUnchanged) {
      values[associationForeignKey] = await guardValue(values[associationForeignKey]);
    }
  }

  return values;
}

async function guardTenantAssociationAction(ctx: any, db: any, resourceName?: string) {
  const association = getAssociationCollections(db, resourceName);
  if (!association || ctx.action?.sourceId === undefined || ctx.action?.sourceId === null) {
    return association;
  }

  const { sourceCollection, targetCollection } = association;
  const sourceTenancyMode = getCollectionTenancyMode(sourceCollection);
  const targetTenancyMode = getCollectionTenancyMode(targetCollection);
  const tenantAware =
    TENANT_ENABLED_MODES.includes(sourceTenancyMode as any) || TENANT_ENABLED_MODES.includes(targetTenancyMode as any);
  if (!tenantAware) {
    return association;
  }

  if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId) {
    ctx.throw(403, translateTenantError(ctx, 'tenantContextRequired'));
  }

  await assertTenantRecordAccess(ctx, sourceCollection, ctx.action.sourceId, 'get');

  const actionName = ctx.action.actionName;
  if (!ASSOCIATION_TARGET_WRITE_ACTIONS.has(actionName)) {
    return association;
  }

  for (const targetKey of getAssociationTargetKeys(actionName, ctx.action.params)) {
    await assertTenantRecordAccess(ctx, targetCollection, targetKey, 'update');
  }

  return association;
}

/**
 * Registers the plugin tenant server plugin integration.
 */
export class PluginTenantServer extends Plugin {
  async ensureTenantAclScope(options: any = {}) {
    const repo = this.db.getRepository('dataSourcesRolesResourcesScopes');
    if (!repo) {
      return;
    }

    await repo.firstOrCreate({
      filterKeys: ['dataSourceKey', 'key'],
      values: {
        dataSourceKey: 'main',
        key: 'tenant',
        name: '{{t("Current tenant records")}}',
        scope: {
          tenantId: '{{ ctx.state.currentTenant.id }}',
        },
      },
      transaction: options.transaction,
    });
  }

  async loadCollections() {
    this.db.collection(tenantsCollection);
    this.db.collection(tenantUsersCollection);
    this.db.extendCollection(usersCollection.collectionOptions, usersCollection.mergeOptions);
  }

  async ensureTenantConfigurableCollectionRecords(options: any = {}) {
    if (!this.db.hasCollection('collections')) {
      return;
    }

    const collectionsRepository = this.db.getRepository('collections') as any;
    if (!collectionsRepository) {
      return;
    }

    for (const collection of this.db.collections.values()) {
      const tenancyMode = getCollectionTenancyMode(collection);
      if (!TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
        continue;
      }

      const exists = await collectionsRepository.findOne({
        filter: { name: collection.name },
        transaction: options.transaction,
      });

      if (exists) {
        continue;
      }

      const { fields, ...values } = collection.options as any;
      await collectionsRepository.create({
        values: {
          ...values,
          from: 'db2cm',
        },
        transaction: options.transaction,
      });
    }
  }

  ensureTenantRuntimeFields() {
    for (const collection of this.db.collections.values()) {
      const tenancyMode = getCollectionTenancyMode(collection);
      if (!TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
        continue;
      }

      if (collection.hasField?.('tenantId')) {
        continue;
      }

      collection.setField('tenantId', {
        type: 'context',
        dataIndex: 'state.currentTenant.id',
        dataType: 'string',
        createOnly: true,
        visible: true,
        index: true,
      });
    }
  }

  async ensureTenantIdFields(options: any = {}) {
    this.ensureTenantRuntimeFields();

    if (!this.db.hasCollection('collections')) {
      return;
    }

    const collectionsRepository = this.db.getRepository('collections') as any;
    if (!collectionsRepository) {
      return;
    }

    const collections = await collectionsRepository.find({
      transaction: options.transaction,
    });

    for (const collection of collections) {
      const tenancyMode = collection.get('tenancy') ?? collection.get('options')?.tenancy;
      if (!TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
        continue;
      }

      await ensureTenantIdField(collection, options);
    }
  }

  async beforeLoad() {
    this.app.i18n.addResources('zh-CN', NAMESPACE, zhCN);
    this.app.i18n.addResources('en-US', NAMESPACE, enUS);

    this.app.resourcer.registerActionHandler('tenants:available', availableTenants);
    this.app.resourcer.registerActionHandler('tenants:current', currentTenant);
    this.app.resourcer.registerActionHandler('tenants:switch', switchTenant);

    this.app.use(
      async (ctx, next) => {
        (ctx.app as any).__application = this.app;
        await next();
      },
      {
        tag: 'tenantApplicationHandoff',
        before: 'auth',
      },
    );

    this.db.on('collections.afterCreateWithAssociations', ensureTenantIdField);
    this.db.on('collections.afterUpdateWithAssociations', ensureTenantIdField);
    this.db.on('collections.afterUpdate', ensureTenantIdField);

    this.app.on('beforeStart', async () => {
      await this.ensureTenantConfigurableCollectionRecords();
    });

    this.app.resourcer.use(setCurrentTenant, {
      tag: 'setCurrentTenant',
      after: 'auth',
      before: 'acl',
    });

    const getRequestedDataSourceKey = (ctx) =>
      ctx.get('X-data-source') || ctx.get('x-data-source') || ctx.action?.params?.dataSource || 'main';

    const getUsableDataSource = (ctx, dataSourceKey: string) => {
      if (!dataSourceKey || dataSourceKey === 'main') {
        return null;
      }

      return this.app.dataSourceManager.dataSources.get(dataSourceKey);
    };

    const emitTenantSecurityViolation = (ctx, event: Record<string, any>) => {
      const app = (ctx as any).tego || (ctx.app as any).__application;
      const emitter = app && typeof app.emit === 'function' ? app : ctx.app;
      emitter?.emit?.('tenant.securityViolation', event);
    };

    const clearInvalidDataSourceKey = (ctx, dataSourceKey: string) => {
      const event = {
        type: 'tenant_invalid_data_source_attempt',
        action: ctx.action?.actionName,
        collectionName: ctx.action?.resourceName,
        details: {
          dataSourceKey,
          headerDataSource: ctx.get?.('x-data-source') || ctx.get?.('X-data-source') || null,
          paramDataSource: ctx.action?.params?.dataSource ?? null,
        },
      };

      for (const headers of [ctx.request?.headers, ctx.request?.header, ctx.headers, ctx.req?.headers]) {
        if (headers) {
          delete headers['x-data-source'];
          delete headers['X-data-source'];
        }
      }

      if (ctx.action?.params) {
        delete ctx.action.params.dataSource;
      }

      ctx.state = ctx.state || {};
      ctx.state.tenantInvalidDataSourceEvent = event;
      return event;
    };

    this.app.use(
      async (ctx, next) => {
        const dataSourceKey = getRequestedDataSourceKey(ctx);
        const dataSource = getUsableDataSource(ctx, dataSourceKey);
        if (dataSourceKey && dataSourceKey !== 'main' && !dataSource?.collectionManager) {
          clearInvalidDataSourceKey(ctx, dataSourceKey);
        }

        await setCurrentTenant(ctx as Parameters<typeof setCurrentTenant>[0], next);
      },
      {
        tag: 'setCurrentTenantForDataSource',
        after: 'auth',
        before: 'dataSource',
      },
    );

    const applyTenantResourceGuard = async (ctx, next) => {
      const dataSourceKey = getRequestedDataSourceKey(ctx);
      const dataSource = getUsableDataSource(ctx, dataSourceKey);
      const db = dataSource?.collectionManager?.db || ctx.db;
      const collectionName = ctx.action.resourceName?.replace(/^api\//, '');
      const collection =
        dataSource?.collectionManager?.getCollection(collectionName) ||
        (collectionName ? dataSource?.collectionManager?.getCollection(ctx.action.resourceName) : null) ||
        db.getCollection(collectionName);

      const association = await guardTenantAssociationAction(ctx, db, collectionName);

      const tenancyMode = getCollectionTenancyMode(collection);
      const repository = collection?.repository || dataSource?.collectionManager?.getRepository?.(collectionName);
      let sourceRecord;

      if (TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
        let unassignedTenantRead = false;
        if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId) {
          const configuredTenant = await this.db.getRepository('tenants').findOne({ fields: ['id'] });
          if (!configuredTenant && isTenantReadAction(ctx.action.actionName)) {
            unassignedTenantRead = true;
            applyUnassignedTenantReadFilter(ctx);
          }
        }

        if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId && !unassignedTenantRead) {
          await setCurrentTenant(ctx, async () => undefined);
        }

        if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId && !unassignedTenantRead) {
          emitTenantSecurityViolation(ctx, {
            type: 'tenant_access_denied',
            userId: ctx.state.currentUser?.id,
            collectionName,
            action: ctx.action?.actionName,
            details: { tenancyMode },
          });
          ctx.throw(403, translateTenantError(ctx, 'tenantContextRequired'));
        }

        ctx.state.currentTenancyMode = tenancyMode;
        ctx.state.currentLegacyDataTenantIds = collection.options?.legacyDataTenantIds || [];
        if (!unassignedTenantRead) {
          applyTenantFilter(ctx);
        }

        sourceRecord = await findWritableRootRecord(ctx, collection, repository);
      } else if (ctx.action.actionName === 'update' && hasTargetKey(ctx.action.params.filterByTk)) {
        sourceRecord = await findTenantRecord(
          ctx,
          collection,
          ctx.action.params.filterByTk,
          'update',
          undefined,
          repository,
        );
      }

      if (ROOT_ASSOCIATION_VALUE_ACTIONS.has(ctx.action.actionName)) {
        ctx.action.params.values = await guardTenantAssociationValues(
          ctx,
          db,
          collection,
          ctx.action.params.values,
          '',
          getAssociationValueUpdatePaths(ctx),
          sourceRecord,
        );
      }

      const tenantAwareMove = [collection, association?.sourceCollection, association?.targetCollection].some((item) =>
        TENANT_ENABLED_MODES.includes(getCollectionTenancyMode(item) as any),
      );
      if (ctx.action.actionName === 'move' && tenantAwareMove) {
        await moveTenantRecords(ctx, db, collectionName);
        ctx.action.params.sourceId = null;
      }

      await next();
    };

    this.app.resourcer.use(
      async (ctx, next) => {
        const invalidDataSourceEvent = ctx.state?.tenantInvalidDataSourceEvent;
        if (invalidDataSourceEvent) {
          delete ctx.state.tenantInvalidDataSourceEvent;
          emitTenantSecurityViolation(ctx, {
            ...invalidDataSourceEvent,
            userId: ctx.state?.currentUser?.id ?? ctx.auth?.user?.id,
            tenantId: ctx.state?.currentTenant?.id ?? ctx.state?.currentTenantId ?? null,
          });
        }

        const dataSourceKey = getRequestedDataSourceKey(ctx);
        if (dataSourceKey && dataSourceKey !== 'main') {
          const dataSource = getUsableDataSource(ctx, dataSourceKey);
          if (dataSource?.collectionManager) {
            await next();
            return;
          }

          clearInvalidDataSourceKey(ctx, dataSourceKey);
        }

        await applyTenantResourceGuard(ctx, next);
      },
      {
        tag: 'tenantResourceGuard',
        after: 'acl',
        before: 'dataSource',
      },
    );

    this.app.dataSourceManager.use(
      async (ctx, next) => {
        await this.app.authManager.middleware()(ctx, async () => undefined);

        if (!ctx.state.currentUser && !ctx.auth?.user && ctx.getBearerToken?.() && ctx.auth?.check) {
          ctx.auth.user = await ctx.auth.check();
        }

        await setCurrentTenant(ctx, async () => undefined);
        await applyTenantResourceGuard(ctx, next);
      },
      {
        tag: 'tenantDataSourceResourceGuard',
        after: 'acl',
      },
    );

    this.app.acl.registerSnippet({
      name: 'pm.tenant.manage',
      actions: ['tenants:*', 'tenantUsers:*', 'users:list', 'users:update', 'collections:list', 'collections:update'],
    });

    this.app.acl.registerSnippet({
      name: TENANT_IMPERSONATION_SNIPPET,
      actions: ['tenants:available', 'tenants:current', 'tenants:switch'],
    });

    const protectTenantAclScope = () => {
      return {
        filter: {
          'key.$ne': 'tenant',
        },
      };
    };

    this.app.acl.addFixedParams('rolesResourcesScopes', 'create', protectTenantAclScope);
    this.app.acl.addFixedParams('rolesResourcesScopes', 'destroy', protectTenantAclScope);
    this.app.acl.addFixedParams('rolesResourcesScopes', 'update', protectTenantAclScope);

    this.app.acl.allow('tenants', ['available', 'current', 'switch'], 'loggedIn');

    this.db.on('tenants.beforeCreate', async (model, options) => {
      const transaction = options?.transaction;
      const parentId = model.get('parentId') || null;
      model.set('parentId', parentId);
      let parentPath: string | null = null;

      if (parentId) {
        const parent = await this.db.getRepository('tenants').findOne({
          filter: { id: parentId },
          transaction,
        });

        if (!parent) {
          throw new Error(translateTenantError(options?.context, 'parentTenantNotFound'));
        }

        if (!parent.get('enabled')) {
          throw new Error(translateTenantError(options?.context, 'parentTenantDisabled'));
        }

        parentPath = parent.get('path') as string;
      }

      // Ensure id is available for path computation.
      // The UidField beforeCreate listener may not have fired yet depending
      // on hook registration order, so eagerly generate the id when missing.
      let id = model.get('id');
      if (!id) {
        id = uid();
        model.set('id', id);
      }
      model.set('path', buildPath(parentPath, id, translateTenantError(options?.context, 'tenantHierarchyTooDeep')));
    });

    this.db.on('tenants.beforeUpdate', async (model, options) => {
      const transaction = options?.transaction;
      const rawParentId = model.get('parentId');

      if (rawParentId === undefined) {
        return;
      }

      const newParentId = rawParentId || null;
      const tenantId = model.get('id') as string;
      const repo = this.db.getRepository('tenants');
      const tenant = await repo.findOne({
        filter: { id: tenantId },
        transaction,
      });
      let parentPath: string | null = null;

      model.set('parentId', newParentId);

      if (tenant && (tenant.get('parentId') || null) === newParentId) {
        return;
      }

      if (newParentId) {
        if (await wouldCreateCycle(repo, tenantId, newParentId, { transaction })) {
          throw new Error(translateTenantError(options?.context, 'tenantCycle'));
        }

        const newParent = await repo.findOne({
          filter: { id: newParentId },
          transaction,
        });

        if (!newParent) {
          throw new Error(translateTenantError(options?.context, 'parentTenantNotFound'));
        }

        if (!newParent.get('enabled')) {
          throw new Error(translateTenantError(options?.context, 'parentTenantDisabled'));
        }

        parentPath = newParent.get('path') as string;
      }

      if (tenant) {
        const oldPath = tenant.get('path') as string;
        const newPath = buildPath(
          parentPath,
          tenantId,
          translateTenantError(options?.context, 'tenantHierarchyTooDeep'),
        );

        if (!oldPath) {
          model.set('path', newPath);
          return;
        }

        const descendants = await getDescendantTenants(repo, tenantId, { includeDisabled: true, transaction });

        model.set('path', newPath);
        for (const desc of descendants) {
          const descPath = desc.get('path') as string;
          const updatedPath = descPath.replace(oldPath, newPath);
          desc.set('path', updatedPath);
          await desc.save({
            hooks: false,
            transaction,
          });
        }
      }
    });

    this.db.on('tenants.beforeDestroy', async (model, options) => {
      const transaction = options?.transaction;
      const tenantId = model.get('id') as string;
      const repo = this.db.getRepository('tenants');

      const children = await repo.find({
        filter: { parentId: tenantId },
        fields: ['id'],
        transaction,
      });

      if (children.length > 0) {
        throw new Error(translateTenantError(options?.context, 'tenantHasChildren'));
      }

      const defaultTenantUsers = await this.db.getRepository('users').count({
        filter: { defaultTenantId: tenantId },
        transaction,
      });

      if (defaultTenantUsers > 0) {
        throw new Error(translateTenantError(options?.context, 'tenantIsUserDefault'));
      }

      const tenantMemberCount = await this.db.getRepository('tenantUsers').count({
        filter: { tenantId },
        transaction,
      });

      if (tenantMemberCount > 0) {
        throw new Error(translateTenantError(options?.context, 'tenantHasMembers'));
      }
    });
  }

  async install(options) {
    await this.ensureTenantAclScope(options);
    await this.ensureTenantIdFields(options);
  }

  async afterEnable() {
    await this.ensureTenantAclScope();
    await this.ensureTenantConfigurableCollectionRecords();
    await this.ensureTenantIdFields();
  }
}

export default PluginTenantServer;
