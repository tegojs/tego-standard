import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessRoleFilterCompiler } from './role-filter';
import {
  assertEmptyMutationFilter,
  cloneDeep,
  invalid,
  normalizeKeys,
  plain,
  validateWriteTransaction,
} from './write-support';

export interface AccessAttachmentRemovalRecord {
  readonly key: string | number;
  readonly path: string;
  readonly filename: string;
  readonly storageId: string | number;
  readonly size: number;
}

export interface AccessAttachmentRemovalProof {
  /** Server-only locked source, not a transport DTO or permission to unlink its content. */
  readonly collection: Collection;
  readonly transaction: Transaction;
  readonly record: AccessAttachmentRemovalRecord;
  /** Valid only inside withRecord. Preparation requires the original row to remain unchanged. */
  assertCurrent(): Promise<void>;
}

interface RemovalContext {
  db: Database;
  action: object;
  permission: unknown;
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid('Attachment removal cannot contain accessors');
  return descriptor?.value;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!plain(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    invalid('Unsupported attachment removal parameters');
  for (const key of Object.getOwnPropertyNames(input)) data(input, key);
}

/** Preparation only: no row deletion, file I/O, commit receipt or runtime registration.
 * The caller owns the transaction and must roll it back on any error.
 */
export function captureAttachmentRemoval(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: RemovalContext,
  authenticated: AccessIdentity,
) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
    invalid('Attachment removal context is unavailable');
  const action = ctx.action;
  const resourceName = data(action, 'resourceName');
  if (
    typeof resourceName !== 'string' ||
    data(action, 'actionName') !== 'destroy' ||
    data(action, 'sourceId') !== undefined ||
    data(action, 'resourceOf') !== undefined
  )
    invalid('Attachment removal requires its root destroy operation');
  const actor = Object.freeze(cloneDeep(authenticated));
  if (typeof actor.roleName !== 'string') invalid('Attachment removal requires an authenticated role');
  const binding = { resourceName, actionName: 'destroy', roleName: actor.roleName };
  const final = ctx.permission;
  const permission = captureFinalActionPermission(final, binding);
  if (!permission.allowed) invalid('Attachment destruction is not authorized');
  const raw = data(final as object, 'rawParams');
  shape(raw, ['resourceName', 'actionName', 'resourceIndex', 'filterByTk', 'filter']);
  assertEmptyMutationFilter(raw.filter);
  if (
    (Object.hasOwn(raw, 'resourceName') && raw.resourceName !== resourceName) ||
    (Object.hasOwn(raw, 'actionName') && raw.actionName !== 'destroy')
  )
    invalid('Attachment removal transport does not match its operation');
  const collection = db.getCollection(resourceName);
  if (!collection || collection.db !== db || collection.options.template !== 'file')
    invalid('Attachment removal requires a registered file collection');
  const model = collection.model;
  const primary = model.primaryKeyAttribute;
  if (collection.filterTargetKey !== primary) invalid('Alternate attachment removal keys require their own adapter');
  const key = normalizeKeys([raw.filterByTk], collection)[0];
  if (raw.resourceIndex !== undefined && normalizeKeys([raw.resourceIndex], collection)[0] !== key)
    invalid('Attachment removal REST locator does not match');
  const identity = cloneDeep(resolveIdentity(collection));
  if (!identity || identity.collectionName !== resourceName) invalid('Attachment collection identity is unavailable');
  const stableKey = accessCollectionKey(identity);
  const config = prepared.configuration(ctx, identity);
  if (!config) invalid('Attachment removal requires a prepared access configuration');
  const grants = permission.params;
  shape(grants, ['fields', 'whitelist', 'blacklist', 'filter', 'own']);
  if (Object.hasOwn(grants, 'own') && grants.own !== false) invalid('Own-record removal permissions must be finalized');
  // Destroy fields describe the action, not a grant to output this internal location.
  for (const name of ['fields', 'whitelist', 'blacklist']) {
    if (grants[name] === undefined) continue;
    const fields = captureAccessFilter(grants[name]);
    if (
      !Array.isArray(fields) ||
      new Set(fields).size !== fields.length ||
      fields.some(
        (field) =>
          typeof field !== 'string' ||
          (!Object.hasOwn(model.rawAttributes, field) && !Object.hasOwn(model.associations, field)),
      )
    )
      invalid('Attachment removal permission fields are invalid');
  }
  const role = new AccessRoleFilterCompiler(db, resolveIdentity).compile(
    identity,
    captureAccessFilter(grants.filter === undefined ? {} : grants.filter),
  );
  const metadata = accessMetadataGuard(db, [{ model, config }]);
  const current = () => {
    const latest = resolveIdentity(collection);
    if (
      ctx.db !== db ||
      ctx.action !== action ||
      ctx.permission !== final ||
      data(action, 'resourceName') !== resourceName ||
      data(action, 'actionName') !== 'destroy' ||
      data(action, 'sourceId') !== undefined ||
      data(action, 'resourceOf') !== undefined ||
      !latest ||
      latest.collectionName !== resourceName ||
      accessCollectionKey(latest) !== stableKey ||
      collection.options.template !== 'file' ||
      collection.filterTargetKey !== primary ||
      prepared.configuration(ctx, identity) !== config ||
      !queries.isCurrentCollection(identity, collection, model) ||
      !isDeepStrictEqual(captureFinalActionPermission(ctx.permission, binding), permission)
    )
      invalid('Attachment removal identity, final decision or preparation phase changed');
    metadata();
    role.assertCurrent();
  };
  const required = [primary, 'path', 'filename', 'storageId', 'size'];
  if (
    model.primaryKeyAttributes.length !== 1 ||
    required.some(
      (field) => !model.rawAttributes[field] || (model.rawAttributes[field].type as { key?: string }).key === 'VIRTUAL',
    )
  )
    invalid('Attachment removal metadata is unavailable');
  current();
  let used = false;
  return Object.freeze({
    async withRecord<T>(consume: (proof: AccessAttachmentRemovalProof) => Promise<T>, transaction: Transaction) {
      if (used || typeof consume !== 'function')
        invalid('Attachment removal entry has already been used or is invalid');
      used = true;
      let active = true;
      const read = async (): Promise<{ record: AccessAttachmentRemovalRecord; owner: unknown }> => {
        if (!active) invalid('Attachment removal proof is no longer active');
        current();
        await validateWriteTransaction(db, transaction, false);
        const plan = await new AccessMutationService(db, prepared, queries).authorizeExisting(
          ctx,
          identity,
          actor,
          { operation: 'destroy', keys: [key], where: role.rootWhere ?? role.where },
          transaction,
        );
        current();
        if (!active) invalid('Attachment removal proof is no longer active');
        const row = plan.records[0];
        const record = Object.freeze({
          key: row.getDataValue(primary),
          path: row.getDataValue('path'),
          filename: row.getDataValue('filename'),
          storageId: row.getDataValue('storageId'),
          size: row.getDataValue('size'),
        });
        if (
          typeof record.path !== 'string' ||
          typeof record.filename !== 'string' ||
          !(
            (typeof record.storageId === 'string' && record.storageId.length > 0 && record.storageId.length <= 255) ||
            (typeof record.storageId === 'number' && Number.isSafeInteger(record.storageId))
          ) ||
          !Number.isSafeInteger(record.size) ||
          record.size < 0
        )
          invalid('Stored attachment removal location is invalid');
        return { record, owner: config.ownership.enabled ? row.getDataValue('tenantId') : undefined };
      };
      try {
        const before = await read();
        const assertCurrent = async () => {
          if (!isDeepStrictEqual(await read(), before)) invalid('Stored attachment removal location or owner changed');
        };
        const record = before.record;
        const result = await consume(Object.freeze({ collection, transaction, record, assertCurrent }));
        // This stage prepares only; consumers may not delete, rewrite or commit the source row.
        await assertCurrent();
        return result;
      } finally {
        active = false;
      }
    },
  });
}
