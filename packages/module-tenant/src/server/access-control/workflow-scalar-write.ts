import { isDeepStrictEqual } from 'node:util';
import { Op, type Collection, type Database, type Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { AccessBelongsToService } from './belongs-to';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessCreationService } from './creation';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationService, type ExistingAccessWritePlan } from './mutation';
import type { AccessQueryService } from './query';
import { AccessReferenceService } from './references';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureWorkflowDestroyParams } from './workflow-destroy-handler';
import { captureWorkflowWriteReferences } from './workflow-write-references';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  plain,
  requiresSerializable,
  rootWriteBlockedFields,
  validateRootValues,
  validateWriteTransaction,
} from './write-support';

/** Structural workflow contract; this module does not import or register the workflow runtime. */
export interface AccessWorkflowScalarWriteRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly params: unknown;
  readonly context: object;
  readonly transaction?: Transaction;
}

export interface AccessWorkflowUpdateResult {
  length: number;
  data: Record<string, unknown>[];
}

/** Capture ordinary fields and existing single-value references; other relationships need separate adapters. */
export function captureWorkflowScalarWrite(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  collection: Collection,
  action: 'create' | 'update',
  raw: unknown,
) {
  const allowed = ['values', 'appends', ...(action === 'update' ? ['filter', 'filterByTk', 'individualHooks'] : [])];
  if (!plain(raw) || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !allowed.includes(key)))
    invalid('Unsupported workflow scalar write parameters');
  const params = cloneDeep(raw);
  const appends = params.appends;
  if (
    appends !== undefined &&
    (!Array.isArray(raw.appends) ||
      Object.getPrototypeOf(raw.appends) !== Array.prototype ||
      Reflect.ownKeys(raw.appends).length !== 1 ||
      raw.appends.length)
  )
    invalid('Workflow write associations require their own adapter');
  const references = captureWorkflowWriteReferences(db, resolveIdentity, collection, params.values);
  const values = references.values;
  // Ownership handling is checked again against the prepared configuration before writing.
  if (action === 'create' || Object.keys(values).length || !references.items.length)
    validateRootValues(db, values, collection, action, true);
  const fields = Object.keys(values).map((name) => {
    const field = collection.getField(name);
    if (field?.options.interface === 'attachment') invalid('Workflow attachment fields require their own adapter');
    return { name, field, interface: field?.options.interface };
  });
  const protectedFields = [...rootWriteBlockedFields(db, collection, action)].sort();
  const assertCurrent = () => {
    references.assertCurrent();
    if (
      fields.some(
        ({ name, field, interface: kind }) => collection.getField(name) !== field || field?.options.interface !== kind,
      )
    )
      invalid('Workflow scalar field interface or protection metadata changed');
  };
  // Protection discovery reads database-wide metadata; keep it out of per-row assertions.
  const assertProtectionCurrent = () => {
    if (!isDeepStrictEqual(protectedFields, [...rootWriteBlockedFields(db, collection, action)].sort()))
      invalid('Workflow scalar protection metadata changed');
  };
  const selection =
    action === 'update'
      ? captureWorkflowDestroyParams(
          Object.fromEntries(
            ['filter', 'filterByTk', 'individualHooks']
              .filter((name) => Object.hasOwn(raw, name))
              .map((name) => [name, raw[name]]),
          ),
        )
      : undefined;
  const condition = new AccessRoleFilterCompiler(db, resolveIdentity);
  return {
    values: values as Record<string, unknown>,
    references,
    selection,
    condition,
    assertCurrent,
    assertProtectionCurrent,
  };
}

/** Called only after the root handler has verified the original live configured create/update operation. */
export async function executeWorkflowScalarWrite(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  operation: {
    action: 'create' | 'update';
    context: object;
    source: Readonly<AccessCollectionIdentity>;
    collection: Collection;
    authenticated: Readonly<AccessIdentity>;
    transaction?: Transaction;
    input: ReturnType<typeof captureWorkflowScalarWrite>;
    assertCurrent(): void;
  },
): Promise<Record<string, unknown> | AccessWorkflowUpdateResult> {
  const { action, context, source, collection, authenticated, transaction, input } = operation;
  operation.assertCurrent();
  input.assertCurrent();
  input.assertProtectionCurrent();
  const config = prepared.configuration(context, source);
  if (!config) invalid('Workflow writes require an explicit access configuration');
  const model = collection.model;
  const ruleMetadata = accessMetadataGuard(db, [{ model, config }]);
  const primary = model.primaryKeyAttribute;
  if (model.primaryKeyAttributes.length !== 1 || collection.filterTargetKey !== primary)
    invalid('Workflow writes require a single primary target key');
  if (action === 'create' || Object.keys(input.values).length || !input.references.items.length)
    validateRootValues(db, input.values, collection, action, config.ownership.enabled);
  const condition = action === 'update' ? input.condition.compile(source, input.selection!.requestFilter) : undefined;
  if (condition && condition.rootWhere === undefined)
    invalid('Workflow write relationship filters require their own adapter');
  const where = condition?.rootWhere;
  const assertCurrent = () => {
    operation.assertCurrent();
    input.assertCurrent();
    ruleMetadata();
    if (
      model.primaryKeyAttributes.length !== 1 ||
      model.primaryKeyAttribute !== primary ||
      collection.filterTargetKey !== primary
    )
      invalid('Workflow write target key changed during execution');
    if (prepared.configuration(context, source) !== config) invalid('Workflow write preparation phase changed');
    condition?.assertCurrent();
  };
  const serializable = input.references.items.length > 0 || requiresSerializable(config, { where }, collection);
  await validateWriteTransaction(db, transaction, serializable);
  assertCurrent();
  let keys: Array<string | number>;
  if (action === 'create') {
    const result = await new AccessCreationService(db, prepared, queries).withCreatedRecordsInTransaction(
      context,
      source,
      authenticated,
      { values: [input.values], references: input.references.items },
      transaction!,
      async (plan) => {
        assertCurrent();
        const created = await collection.repository.create({
          values: plan.values[0],
          transaction: plan.transaction,
          context,
        });
        assertCurrent();
        return [created];
      },
      assertCurrent,
    );
    keys = result.keys;
  } else {
    if (
      !input.references.items.length &&
      !Object.keys(input.values).some((name) => !config.ownership.enabled || name !== 'tenantId')
    )
      invalid('No ordinary workflow fields to update');
    const explicit = input.selection!.params.filterByTk;
    if (explicit !== undefined) keys = normalizeKeys(Array.isArray(explicit) ? explicit : [explicit], collection);
    else {
      const scoped = await queries.scopeQuery(context, source, authenticated, { where, transaction }, 'ownership');
      assertCurrent();
      if (!scoped || scoped.config !== config) invalid('Workflow write preparation phase changed');
      const records = await model.findAll(
        internalQuery({
          ...scoped.query,
          attributes: [primary],
          order: [[primary, 'ASC']],
          limit: 1001,
          lock: transaction!.LOCK.UPDATE,
        }),
      );
      assertCurrent();
      if (records.length > 1000) invalid('Workflow update exceeds the 1000-record write limit');
      if (!records.length) {
        await validateWriteTransaction(db, transaction, serializable);
        assertCurrent();
        input.assertProtectionCurrent();
        return { length: 0, data: [] };
      }
      keys = normalizeKeys(
        records.map((record) => record.getDataValue(primary)),
        collection,
      );
    }
    const mutations = new AccessMutationService(db, prepared, queries);
    const writer = async (plan: ExistingAccessWritePlan) => {
      for (const record of plan.records) {
        assertCurrent();
        await collection.repository.update({
          filter: { [primary]: record.getDataValue(primary) },
          values: plan.valuesFor(record),
          transaction: plan.transaction,
          context,
          ...input.selection!.hookOptions,
        });
        assertCurrent();
      }
    };
    const result = input.references.items.length
      ? await new AccessBelongsToService(
          db,
          prepared,
          queries,
          mutations,
          new AccessReferenceService(db, prepared, queries),
        ).withReferencesInTransaction(
          context,
          source,
          authenticated,
          {
            sourceKeys: keys,
            sourceWhere: where,
            sourceValues: Object.keys(input.values).length ? input.values : undefined,
            references: input.references.items.map((item) => ({
              association: item.association,
              target: item.target,
              targetKey: item.key,
            })),
          },
          transaction!,
          writer,
          { assertCurrent, targetScope: async () => ({}) },
        )
      : await mutations.withExistingRecordsInTransaction(
          context,
          source,
          authenticated,
          { operation: 'update', keys, values: input.values, where },
          transaction!,
          writer,
          assertCurrent,
        );
    keys = result.keys;
  }
  assertCurrent();
  input.assertProtectionCurrent();
  // The configured write grants its own scalar result, never arbitrary related-table reads.
  const attributes = Object.keys(model.rawAttributes).filter(
    (name) => (model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL',
  );
  const records = await model.unscoped().findAll(
    internalQuery({
      where: { [primary]: { [Op.in]: keys } },
      attributes,
      order: [[primary, 'ASC']],
      transaction,
    }),
  );
  // Keep ORM type decoding without invoking custom getters or expanding associations.
  const rows = records.map((record) => Object.fromEntries(attributes.map((name) => [name, record.getDataValue(name)])));
  await validateWriteTransaction(db, transaction, serializable);
  assertCurrent();
  input.assertProtectionCurrent();
  if (rows.length !== keys.length) invalid('Workflow write result is unavailable');
  return action === 'create' ? rows[0] : { length: rows.length, data: rows };
}
