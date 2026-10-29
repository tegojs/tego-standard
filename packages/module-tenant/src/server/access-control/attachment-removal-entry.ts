import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection, type Database } from '@tego/server';

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
  internalQuery,
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

/** Server-only predicate snapshot. It does not authorize DELETE, commit or physical cleanup. */
export interface AccessAttachmentRemovalNativeProof extends AccessAttachmentRemovalProof {
  readonly sql: string;
  readonly rootAlias: string;
}

/** Trusted server collaborator, never supplied by action parameters or treated as a transport DTO. */
export interface AccessAttachmentRemovalEvidenceAdapter {
  prepare(proof: AccessAttachmentRemovalProof): Promise<{
    beforeDelete(): Promise<void>;
    afterDelete(): Promise<void>;
    assertCurrent(): Promise<void>;
    testPredicate(predicate: { readonly sql: string; readonly rootAlias: string }): Promise<boolean>;
    /** Optional same-transaction marker, never a permission for physical cleanup. */
    complete?(): Promise<void>;
  }>;
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

/** Internal preparation and separate explicit SQL execution; never file I/O or runtime registration.
 * Preparation uses the caller transaction. executeNativeRemoval owns its root transaction.
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
  const withInitialRecord = async <T>(
    consume: (proof: AccessAttachmentRemovalProof, owner: unknown) => Promise<T>,
    transaction: Transaction,
  ): Promise<T> => {
    if (used || typeof consume !== 'function') invalid('Attachment removal entry has already been used or is invalid');
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
      return await consume(Object.freeze({ collection, transaction, record, assertCurrent }), before.owner);
    } finally {
      active = false;
    }
  };
  const withLockedRecord = <T>(
    consume: (proof: AccessAttachmentRemovalProof, owner: unknown) => Promise<T>,
    transaction: Transaction,
  ) =>
    withInitialRecord(async (proof, owner) => {
      const result = await consume(proof, owner);
      // Preparation always retains its original postcondition, even beside the separate executor.
      await proof.assertCurrent();
      return result;
    }, transaction);
  const nativePolicy = async (proof: AccessAttachmentRemovalProof, owner: unknown) => {
    current();
    const nativeRole = new AccessRoleFilterCompiler(db, resolveIdentity).compileNative(
      identity,
      captureAccessFilter(grants.filter === undefined ? {} : grants.filter),
    );
    const scopes = await queries.resolveNativeScopes(ctx, identity, actor, {
      rootAlias: nativeRole.rootAlias,
      transaction: proof.transaction,
    });
    current();
    await validateWriteTransaction(db, proof.transaction, false);
    nativeRole.assertCurrent();
    if (!scopes || scopes.config !== config) invalid('Attachment removal native preparation phase changed');
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const generator = db.sequelize.getQueryInterface().queryGenerator as unknown as {
      escape(value: unknown): string | number;
    };
    const expected: Array<[string, unknown]> = [
      [primary, proof.record.key],
      ['path', proof.record.path],
      ['filename', proof.record.filename],
      ['size', proof.record.size],
      ['storageId', proof.record.storageId],
      ...(config.ownership.enabled ? ([['tenantId', owner]] as Array<[string, unknown]>) : []),
    ];
    const snapshot = expected.map(
      ([field, value]) =>
        `${quote(nativeRole.rootAlias)}.${quote(model.rawAttributes[field].field || field)} = ${generator.escape(value)}`,
    );
    return {
      sql: [scopes.scopes.ownership.sql, nativeRole.sql, ...snapshot].map((part) => `(${part})`).join(' AND '),
      rootAlias: nativeRole.rootAlias,
      assertCurrent() {
        current();
        nativeRole.assertCurrent();
      },
    };
  };
  return Object.freeze({
    async withRecord<T>(consume: (proof: AccessAttachmentRemovalProof) => Promise<T>, transaction: Transaction) {
      if (typeof consume !== 'function') invalid('Attachment removal entry has already been used or is invalid');
      return withLockedRecord((proof) => consume(proof), transaction);
    },
    async withNativePredicate<T>(
      consume: (proof: AccessAttachmentRemovalNativeProof) => Promise<T>,
      transaction: Transaction,
    ) {
      if (typeof consume !== 'function') invalid('Attachment removal entry has already been used or is invalid');
      return withLockedRecord(async (proof, owner) => {
        const policy = await nativePolicy(proof, owner);
        const assertCurrent = async () => {
          policy.assertCurrent();
          await proof.assertCurrent();
          policy.assertCurrent();
        };
        await assertCurrent();
        const result = await consume(
          Object.freeze({ ...proof, sql: policy.sql, rootAlias: policy.rootAlias, assertCurrent }),
        );
        policy.assertCurrent();
        return result;
      }, transaction);
    },
    /** Explicit SQL deletion only. The injected evidence adapter must be trusted server composition.
     * Owns commit/rollback; no caller transaction, paths, SQL, deletion callback or cleanup permit.
     */
    async executeNativeRemoval(evidence: AccessAttachmentRemovalEvidenceAdapter): Promise<number> {
      if (db.sequelize.getDialect() !== 'postgres' || !evidence || typeof evidence.prepare !== 'function')
        invalid('Native attachment removal requires PostgreSQL and a trusted evidence adapter');
      return db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, (transaction) =>
        withInitialRecord(async (proof, owner) => {
          await validateWriteTransaction(db, transaction, true);
          const initial = await nativePolicy(proof, owner);
          await proof.assertCurrent();
          const session = await evidence.prepare(proof);
          if (
            !session ||
            (['beforeDelete', 'afterDelete', 'assertCurrent', 'testPredicate'] as const).some(
              (key) => typeof session[key] !== 'function',
            ) ||
            (session.complete !== undefined && typeof session.complete !== 'function')
          )
            invalid('Attachment removal evidence session is unavailable');
          await session.beforeDelete();
          await proof.assertCurrent();
          initial.assertCurrent();
          const affected = await collection.repository.destroy({ filterByTk: key, transaction });
          if (affected !== 1) invalid('Attachment removal did not delete exactly one original row');
          // Deferred constraint triggers must finish before evaluating final authorization.
          // Keep constraints immediate for the remainder of this owned transaction.
          await db.sequelize.query('SET CONSTRAINTS ALL IMMEDIATE', { transaction });
          await session.afterDelete();
          const assertAbsent = async () => {
            current();
            const row = await model.unscoped().findByPk(
              key,
              internalQuery({
                attributes: [primary],
                transaction,
                paranoid: false,
                lock: transaction.LOCK.UPDATE,
              }),
            );
            current();
            if (row) invalid('Attachment removal source row still exists after deletion');
          };
          await assertAbsent();
          // Resolve again after all Repository hooks, including current tenant/hierarchy facts.
          const finalPolicy = await nativePolicy(proof, owner);
          if (
            (await session.testPredicate(Object.freeze({ sql: finalPolicy.sql, rootAlias: finalPolicy.rootAlias }))) !==
            true
          )
            invalid('Attachment removal final native authorization failed');
          await session.assertCurrent();
          const checked = await nativePolicy(proof, owner);
          if (checked.sql !== finalPolicy.sql || checked.rootAlias !== finalPolicy.rootAlias)
            invalid('Attachment removal final native authorization changed during verification');
          initial.assertCurrent();
          finalPolicy.assertCurrent();
          checked.assertCurrent();
          await assertAbsent();
          await validateWriteTransaction(db, transaction, true);
          current();
          if (session.complete) {
            await session.complete();
            await session.assertCurrent();
            const completedPolicy = await nativePolicy(proof, owner);
            if (completedPolicy.sql !== checked.sql || completedPolicy.rootAlias !== checked.rootAlias)
              invalid('Attachment removal final native authorization changed during completion');
            if (
              (await session.testPredicate(
                Object.freeze({
                  sql: completedPolicy.sql,
                  rootAlias: completedPolicy.rootAlias,
                }),
              )) !== true
            )
              invalid('Attachment removal final native authorization failed after completion');
            await session.assertCurrent();
            const settled = await nativePolicy(proof, owner);
            if (settled.sql !== completedPolicy.sql || settled.rootAlias !== completedPolicy.rootAlias)
              invalid('Attachment removal final native authorization changed after completion');
            settled.assertCurrent();
            completedPolicy.assertCurrent();
            await assertAbsent();
            await validateWriteTransaction(db, transaction, true);
            current();
          }
          return affected;
        }, transaction),
      );
    },
  });
}
