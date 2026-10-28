import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database, Field, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessCreationService } from './creation';
import type { AccessAttachmentCreationStorage } from './creation-attachment-storage';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessRoleFilterCompiler } from './role-filter';
import {
  cloneDeep,
  invalid,
  managedFileFields,
  plain,
  validateRootValues,
  validateWriteTransaction,
} from './write-support';

interface AttachmentCreationContext {
  db: Database;
  action: object;
  permission: unknown;
}

export interface AccessAttachmentCreationInput {
  transaction: Transaction;
  /** Trusted storage-plan metadata, never multipart body or action values. */
  metadata: object;
  storage: AccessAttachmentCreationStorage;
  /** Copy bytes only in this stage; the caller owns rollback and compensation. */
  afterPersist(): Promise<void>;
  /** Trusted file adapter's physical metadata check using the actual INSERT receipt. */
  verifyRecord(key: string | number, transaction: Transaction): Promise<void>;
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Attachment creation cannot contain accessors');
  return descriptor.value;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!plain(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    invalid('Unsupported attachment creation parameters');
  for (const key of Object.getOwnPropertyNames(input)) data(input, key);
}

function names(input: unknown): string[] | undefined {
  if (input === undefined) return;
  const value = captureAccessFilter(input);
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string') || new Set(value).size !== value.length)
    invalid('Attachment field grants must be distinct names');
  return value as string[];
}

/** Source-field ACL only, never source-row G or permission to create a file.
 * Combine with the actual storage selection, file entry and subsequent full source write.
 */
export function captureAttachmentFieldPermission(
  db: Database,
  ctx: AttachmentCreationContext,
  roleName: string,
  field: Field,
  target: Collection,
) {
  const source = field?.collection;
  if (!source || ctx.db !== db || !ctx.action || typeof ctx.action !== 'object')
    invalid('Attachment field permission requires its registered source context');
  const action = ctx.action;
  const resourceName = data(action, 'resourceName');
  const actionName = data(action, 'actionName');
  if (
    resourceName !== source.name ||
    !['create', 'update'].includes(actionName as string) ||
    data(action, 'sourceId') !== undefined ||
    data(action, 'resourceOf') !== undefined
  )
    invalid('Attachment field permission requires its source write operation');
  const binding = { resourceName: source.name, actionName: actionName as string, roleName };
  const final = ctx.permission;
  const permission = captureFinalActionPermission(final, binding);
  if (!permission.allowed) invalid('Attachment source write operation is not authorized');
  const params = permission.params as { whitelist?: unknown; blacklist?: unknown };
  const whitelist = names(params.whitelist);
  const blacklist = names(params.blacklist);
  const name = field.name;
  const sourceModel = source.model;
  const targetModel = target?.model;
  const sourceName = source.name;
  const targetName = target?.name;
  const relation = sourceModel.associations[name];
  const type = field.type;
  const foreignKey = (relation as typeof relation & { foreignKey?: string })?.foreignKey;
  const tables = JSON.stringify([sourceModel.getTableName(), targetModel?.getTableName()]);
  if (
    (whitelist !== undefined && !whitelist.includes(name)) ||
    blacklist?.includes(name) ||
    (type === 'belongsTo' && foreignKey !== undefined && blacklist?.includes(foreignKey))
  )
    invalid('Attachment source field is not authorized');
  const current = () => {
    if (
      ctx.db !== db ||
      ctx.action !== action ||
      ctx.permission !== final ||
      data(action, 'resourceName') !== resourceName ||
      data(action, 'actionName') !== actionName ||
      data(action, 'sourceId') !== undefined ||
      data(action, 'resourceOf') !== undefined ||
      source.db !== db ||
      source.name !== sourceName ||
      db.getCollection(sourceName) !== source ||
      source.model !== sourceModel ||
      db.modelCollection.get(sourceModel) !== source ||
      field.collection !== source ||
      field.database !== db ||
      source.getField(name) !== field ||
      field.name !== name ||
      field.type !== type ||
      !['belongsTo', 'belongsToMany'].includes(type) ||
      !target ||
      target.db !== db ||
      target.name !== targetName ||
      db.getCollection(targetName) !== target ||
      target.model !== targetModel ||
      db.modelCollection.get(targetModel) !== target ||
      target.options.template !== 'file' ||
      field.options.target !== targetName ||
      !relation ||
      sourceModel.associations[name] !== relation ||
      relation.source !== sourceModel ||
      relation.target !== targetModel ||
      relation.associationType !== (type === 'belongsTo' ? 'BelongsTo' : 'BelongsToMany') ||
      (relation as typeof relation & { foreignKey?: string }).foreignKey !== foreignKey ||
      JSON.stringify([sourceModel.getTableName(), targetModel.getTableName()]) !== tables ||
      !isDeepStrictEqual(captureFinalActionPermission(ctx.permission, binding), permission)
    )
      invalid('Attachment source field permission changed or is unavailable');
  };
  current();
  return Object.freeze({ field, assertCurrent: current });
}

/** Capture only after the complete ACL chain, before staging or storage I/O. No runtime routes are registered. */
export function captureAttachmentCreation(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AttachmentCreationContext,
  authenticated: AccessIdentity,
) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
    invalid('Attachment creation database or authenticated context is unavailable');
  const action = ctx.action;
  const resourceName = data(action, 'resourceName');
  const actionName = data(action, 'actionName');
  if (
    typeof resourceName !== 'string' ||
    !['create', 'upload'].includes(actionName as string) ||
    data(action, 'sourceId') !== undefined ||
    data(action, 'resourceOf') !== undefined
  )
    invalid('Unsupported attachment creation action');
  const actor = Object.freeze(cloneDeep(authenticated));
  if (typeof actor.roleName !== 'string') invalid('Attachment creation requires an authenticated role');
  const final = ctx.permission;
  const permission = captureFinalActionPermission(final, {
    resourceName,
    actionName: actionName as string,
    roleName: actor.roleName,
  });
  if (!permission.allowed) invalid('Attachment creation action is not authorized');
  if (!plain(final)) invalid('Final attachment context is unavailable');
  const raw = data(final, 'rawParams');
  shape(raw, [
    'resourceName',
    'actionName',
    'associatedName',
    'associatedIndex',
    'resourceIndex',
    'filterByTk',
    'values',
  ]);
  for (const [key, expected] of [
    ['resourceName', resourceName],
    ['actionName', actionName],
    ['associatedName', undefined],
    ['associatedIndex', undefined],
    ['resourceIndex', undefined],
    ['filterByTk', undefined],
  ] as const)
    if (Object.hasOwn(raw, key) && raw[key] !== expected) invalid('Attachment transport metadata does not match');
  const collection = db.getCollection(resourceName);
  if (!collection || collection.db !== db || collection.options.template !== 'file')
    invalid('Attachment creation requires a registered file collection');
  const model = collection.model;
  const identity = cloneDeep(resolveIdentity(collection));
  if (!identity || identity.collectionName !== resourceName) invalid('Attachment collection identity is unavailable');
  const stableKey = accessCollectionKey(identity);
  const config = prepared.configuration(ctx, identity);
  if (!config) invalid('Attachment creation requires a prepared access configuration');
  const managed = managedFileFields(collection);
  const input = cloneDeep(raw.values === undefined ? {} : raw.values);
  if (!plain(input)) invalid('Supply root attachment field values');
  validateRootValues(db, input, collection, 'create');
  if (Reflect.ownKeys(input).some((name) => typeof name !== 'string' || name === 'tenantId' || managed.includes(name)))
    invalid('Client values cannot assign managed attachment metadata');
  shape(permission.params, ['fields', 'whitelist', 'blacklist', 'filter', 'own']);
  if (Object.hasOwn(permission.params, 'own') && permission.params.own !== false)
    invalid('Own-record attachment permissions must be finalized');
  // Some custom new-data actions retain fields; create converts them to whitelist. Both restrict input.
  const fields = names(permission.params.fields);
  const whitelist = names(permission.params.whitelist);
  const blacklist = names(permission.params.blacklist);
  if (
    [...(fields ?? []), ...(whitelist ?? []), ...(blacklist ?? [])].some(
      (field) => !Object.hasOwn(model.rawAttributes, field) && !Object.hasOwn(model.associations, field),
    )
  )
    invalid('Attachment permission contains unsupported fields');
  const client = Object.fromEntries(
    Object.entries(input).filter(
      ([field]) =>
        (fields === undefined || fields.includes(field)) &&
        (whitelist === undefined || whitelist.includes(field)) &&
        !blacklist?.includes(field),
    ),
  );
  const role = new AccessRoleFilterCompiler(db, resolveIdentity).compile(
    identity,
    captureAccessFilter(permission.params.filter === undefined ? {} : permission.params.filter),
  );
  const metadataGuard = accessMetadataGuard(db, [{ model, config }]);
  const current = () => {
    const latest = resolveIdentity(collection);
    if (
      ctx.db !== db ||
      ctx.action !== action ||
      ctx.permission !== final ||
      data(action, 'resourceName') !== resourceName ||
      data(action, 'actionName') !== actionName ||
      data(action, 'sourceId') !== undefined ||
      data(action, 'resourceOf') !== undefined ||
      !latest ||
      latest.collectionName !== resourceName ||
      accessCollectionKey(latest) !== stableKey ||
      collection.options.template !== 'file' ||
      prepared.configuration(ctx, identity) !== config ||
      !queries.isCurrentCollection(identity, collection, model)
    )
      invalid('Attachment entry identity or preparation phase changed');
    metadataGuard();
    role.assertCurrent();
  };
  current();
  let consumed = false;
  return Object.freeze({
    async create(input: AccessAttachmentCreationInput) {
      if (consumed) invalid('Attachment creation entry has already been consumed');
      consumed = true;
      current();
      if (
        !plain(input) ||
        !plain(input.metadata) ||
        !plain(input.storage) ||
        typeof input.afterPersist !== 'function' ||
        typeof input.verifyRecord !== 'function'
      )
        invalid('Attachment creation requires its trusted storage and verification stages');
      const metadata = cloneDeep(input.metadata);
      shape(metadata, [...managed, 'title']);
      if (managed.some((field) => !Object.hasOwn(metadata, field)))
        invalid('Attachment storage metadata is incomplete');
      const selectedKey = data(input.storage, 'key');
      if (
        !['string', 'number'].includes(typeof metadata.storageId) ||
        !['string', 'number'].includes(typeof selectedKey) ||
        String(metadata.storageId) !== String(selectedKey)
      )
        invalid('Attachment metadata does not match its selected storage');
      delete metadata.storageId;
      const transaction = input.transaction;
      const verifyRecord = input.verifyRecord;
      const afterPersist = input.afterPersist;
      const result = await new AccessCreationService(db, prepared, queries).withCreatedAttachmentInTransaction(
        ctx,
        identity,
        actor,
        { values: [{ ...metadata, ...client }], where: role.rootWhere ?? role.where },
        transaction,
        input.storage,
        async (plan) => {
          current();
          const record = await collection.repository.create({
            values: plan.values[0],
            transaction: plan.transaction,
            context: ctx,
          });
          current();
          return [record];
        },
        current,
        afterPersist,
      );
      await verifyRecord(result.keys[0], transaction);
      await validateWriteTransaction(db, transaction, true);
      current();
      return result;
    },
  });
}
