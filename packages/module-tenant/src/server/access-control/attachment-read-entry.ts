import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessEntryReadService } from './entry-reads';
import { captureFinalActionPermission } from './final-action-permission';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { captureReadKey } from './read-key';
import { captureReadPreparationMetadata } from './read-preparation-metadata';
import { resolveResourceReadRoute } from './resource-read-routing';
import { AccessRoleFilterCompiler } from './role-filter';
import type { AccessRootReadContext } from './root-read-context';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessAttachmentReadRecord {
  readonly key: string | number;
  readonly path: string;
  readonly filename: string;
  readonly storageId: string | number;
  readonly size: number;
}

export interface AccessAttachmentReadProof {
  /** Server-only registered source collection. Never include this capability in an HTTP response. */
  readonly collection: Collection;
  readonly record: AccessAttachmentReadRecord;
  /** Recheck after storage/file awaits and before releasing bytes. Valid only inside withRecord. */
  assertCurrent(): Promise<void>;
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid('Attachment reads cannot contain accessors');
  return descriptor?.value;
}

/** Internal download decision only. Does not register an action/route or send file content. */
export function captureAttachmentRead(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
    invalid('Attachment read context is unavailable');
  const action = ctx.action;
  const resourceName = data(action, 'resourceName');
  if (
    typeof resourceName !== 'string' ||
    data(action, 'actionName') !== 'download' ||
    data(action, 'sourceId') !== undefined ||
    data(action, 'resourceOf') !== undefined
  )
    invalid('Attachment reading requires its root download operation');
  const actor = Object.freeze(cloneDeep(authenticated));
  if (typeof actor.roleName !== 'string') invalid('Attachment reading requires an authenticated role');
  const binding = { resourceName, actionName: 'download', roleName: actor.roleName };
  const final = ctx.permission;
  const permission = captureFinalActionPermission(final, binding);
  if (!permission.allowed) invalid('Attachment download is not authorized');
  const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName, actionName: 'get' });
  const collection = db.getCollection(resourceName);
  const model = collection.model;
  const primary = model.primaryKeyAttribute;
  const keyField = collection.filterTargetKey;
  const required = [primary, 'path', 'filename', 'storageId', 'size'];
  const raw = data(final as object, 'rawParams');
  if (
    !plain(raw) ||
    Reflect.ownKeys(raw).some(
      (key) => typeof key !== 'string' || !['resourceName', 'actionName', 'filterByTk', 'resourceIndex'].includes(key),
    )
  )
    invalid('Unsupported attachment download parameters');
  for (const key of Object.getOwnPropertyNames(raw)) data(raw, key);
  const locator = captureReadKey(collection, raw.filterByTk, keyField);
  const rest = raw.resourceIndex === undefined ? undefined : captureReadKey(collection, raw.resourceIndex, keyField);
  if (
    (Object.hasOwn(raw, 'resourceName') && raw.resourceName !== resourceName) ||
    (Object.hasOwn(raw, 'actionName') && raw.actionName !== 'download') ||
    (rest !== undefined && rest.value !== locator.value) ||
    raw.filterByTk === '_'
  )
    invalid('Attachment download locator does not match its operation');
  const config = prepared.configuration(ctx, route.identity);
  if (!config) invalid('Attachment reading requires a prepared access configuration');
  const role = new AccessReadGrantAdapter(db, (target) => {
    const identity = resolveIdentity(target);
    return identity && accessCollectionKey(identity);
  }).capturePlan(route.identity, permission, new AccessRoleFilterCompiler(db, resolveIdentity));
  if (!role || required.some((field) => !role.grant.fields.includes(field)))
    invalid('Attachment location fields are not readable');
  const metadata = captureReadPreparationMetadata(db, prepared, resolveIdentity, ctx, collection, []);
  const current = () => {
    route.assertCurrent();
    locator.assertCurrent();
    metadata();
    role.assertCurrent();
    if (
      ctx.db !== db ||
      ctx.action !== action ||
      ctx.permission !== final ||
      data(action, 'resourceName') !== resourceName ||
      data(action, 'actionName') !== 'download' ||
      data(action, 'sourceId') !== undefined ||
      data(action, 'resourceOf') !== undefined ||
      collection.model !== model ||
      collection.options.template !== 'file' ||
      model.primaryKeyAttributes.length !== 1 ||
      model.primaryKeyAttribute !== primary ||
      prepared.configuration(ctx, route.identity) !== config ||
      !isDeepStrictEqual(captureFinalActionPermission(ctx.permission, binding), permission)
    )
      invalid('Attachment read identity, decision or preparation phase changed');
  };
  current();
  const reader = new AccessEntryReadService(db, prepared, queries, resolveIdentity, (target, path) =>
    target === collection && !path.length ? permission : null,
  );
  let used = false;
  return Object.freeze({
    async withRecord<T>(
      consume: (proof: AccessAttachmentReadProof) => Promise<T>,
      transaction?: Transaction,
    ): Promise<T> {
      if (used || typeof consume !== 'function') invalid('Attachment read entry has already been used or is invalid');
      used = true;
      let active = true;
      const read = async (): Promise<AccessAttachmentReadRecord> => {
        if (!active) invalid('Attachment read proof is no longer active');
        current();
        const row = await reader.getSelected(ctx, route.identity, actor, {
          key: locator.value,
          keyField: locator.field,
          fields: required,
          transaction,
        });
        current();
        if (!active) invalid('Attachment read proof is no longer active');
        if (!row) throw new AccessMutationError('ACCESS_RECORD_UNAVAILABLE', 'Attachment is unavailable for this read');
        if (
          !['string', 'number'].includes(typeof row[primary]) ||
          typeof row.path !== 'string' ||
          typeof row.filename !== 'string' ||
          !['string', 'number'].includes(typeof row.storageId) ||
          !Number.isSafeInteger(row.size) ||
          (row.size as number) < 0
        )
          invalid('Stored attachment location is invalid');
        return Object.freeze({
          key: row[primary],
          path: row.path,
          filename: row.filename,
          storageId: row.storageId,
          size: row.size,
        }) as AccessAttachmentReadRecord;
      };
      try {
        const record = await read();
        return await consume(
          Object.freeze({
            collection,
            record,
            async assertCurrent() {
              if (!isDeepStrictEqual(await read(), record)) invalid('Stored attachment location changed');
            },
          }),
        );
      } finally {
        active = false;
      }
    },
  });
}
