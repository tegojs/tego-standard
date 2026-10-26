import { isDeepStrictEqual } from 'node:util';
import { Op, Transaction, type Database, type Model, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessMutationSelection, AccessMutationService } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
import { guardRelationshipUpdate } from './relationship-write-guard';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import {
  cloneDeep,
  hasPersistedChanges,
  internalQuery,
  invalid,
  normalizeKeys,
  plain,
  snapshotProtectedValues,
  validateWriteTransaction,
} from './write-support';

export interface TargetForeignKeyWriteRequest {
  association: string;
  operation: 'add' | 'remove' | 'set';
  sourceKey: string | number;
  /** Root form patch, already sanitized by finalized field ACL; presence requests a source result. */
  sourceValues?: Record<string, unknown>;
  targetKeys: Array<string | number>;
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  /** Update ACL predicates, also applied to implicit removals. */
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  /** Read/reference ACL predicates for explicitly selected targets, including unchanged ones. */
  targetReadWhere?: WhereOptions;
  targetReadBind?: Record<string, unknown>;
}

/** Trusted final-ACL entry; request values must never supply these callbacks. */
export interface TargetForeignKeyMutationEntry {
  assertCurrent(): void;
  sourceScope?: AccessMutationSelection;
  targetReadScope(): Promise<{ where?: WhereOptions }>;
  targetWriteScope(): Promise<{ where?: WhereOptions }>;
  /** Explicit lifecycle stage after every relation write, before final verification. */
  afterPersist?(): Promise<void>;
  /** Trusted repository-local async context; must execute and await the guarded write. */
  withWriteContext?(side: 'source' | 'target', writer: () => Promise<void>): Promise<void>;
}

/** Changes target foreign keys; all actual child writes are authorized against their old G. */
export abstract class AccessTargetForeignKeyService {
  protected constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly mutations: AccessMutationService,
    private readonly references: AccessReferenceService,
    private readonly associationType: 'HasMany' | 'HasOne',
  ) {}

  protected async writeChildren(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: TargetForeignKeyWriteRequest,
    entry?: TargetForeignKeyMutationEntry,
    inheritedTransaction?: Transaction,
  ): Promise<{
    keys: Array<string | number>;
    affected: number;
    /** Present only for root form patches, with the persisted source key. */
    sourceResult?: { keys: Array<string | number>; affected: number };
  }> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    if (this.db.sequelize.getDialect() !== 'postgres')
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relationship writes require PostgreSQL', 400);
    const afterPersist = entry?.afterPersist;
    if (afterPersist !== undefined && typeof afterPersist !== 'function')
      invalid('A persistence stage must be a function');
    const withWriteContext = entry?.withWriteContext;
    if (withWriteContext !== undefined && typeof withWriteContext !== 'function')
      invalid('A repository write context must be a function');
    const writeInContext = async (side: 'source' | 'target', writer: () => Promise<void>) => {
      if (!withWriteContext) return writer();
      let pending: Promise<void> | undefined;
      let calls = 0;
      let open = true;
      try {
        await withWriteContext.call(entry, side, () => {
          if (!open || ++calls !== 1) invalid('A repository write context must execute exactly one guarded write');
          pending = writer();
          void pending.catch(() => {});
          return pending;
        });
        if (calls !== 1 || !pending) invalid('A repository write context must execute exactly one guarded write');
        await pending;
      } finally {
        open = false;
        await pending?.catch(() => {});
      }
    };
    const allowed = [
      'association',
      'operation',
      'sourceKey',
      'sourceValues',
      'targetKeys',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
      'targetReadWhere',
      'targetReadBind',
    ];
    if (!plain(request) || Reflect.ownKeys(request).some((key) => typeof key !== 'string' || !allowed.includes(key)))
      invalid('Unsupported child mutation input');
    if (!['add', 'remove', 'set'].includes(request.operation)) invalid('Unsupported child operation');
    const relation = resolveTargetForeignKey(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      source,
      target,
      request.association,
      this.associationType,
    );
    const stageMetadata = afterPersist
      ? accessMetadataGuard(
          this.db,
          [
            { model: relation.sourceModel, config: relation.sourceConfig },
            { model: relation.targetModel, config: relation.targetConfig },
          ],
          [{ model: relation.sourceModel, path: [request.association] }],
        )
      : undefined;
    const current = () => {
      relation.current();
      stageMetadata?.();
      entry?.assertCurrent();
    };
    current();
    const sourceKey = normalizeKeys([request.sourceKey], relation.source)[0];
    const targetKeys =
      Array.isArray(request.targetKeys) && request.targetKeys.length === 0
        ? []
        : normalizeKeys(request.targetKeys, relation.target);
    if (
      this.associationType === 'HasOne' &&
      (request.operation === 'add' ||
        (request.operation === 'set' && targetKeys.length > 1) ||
        (request.operation === 'remove' && targetKeys.length > 0))
    )
      invalid('HasOne writes require one replacement target or an implicit remove');
    try {
      const execute = async (transaction: Transaction) => {
        await validateWriteTransaction(this.db, transaction, true);
        current();
        const sourceRequest = { keys: [sourceKey], where: request.sourceWhere, bind: request.sourceBind };
        const sourcePlan =
          request.sourceValues !== undefined && Object.keys(request.sourceValues).length
            ? await this.mutations.authorizeExisting(
                ctx,
                source,
                authenticated,
                { ...sourceRequest, operation: 'update', values: request.sourceValues },
                transaction,
                entry?.sourceScope,
              )
            : await this.mutations.authorizeReferenceSource(
                ctx,
                source,
                authenticated,
                sourceRequest,
                transaction,
                entry?.sourceScope,
              );
        current();
        const primary = relation.targetModel.primaryKeyAttribute;
        const candidateWhere = {
          [Op.or]: [
            { [primary]: { [Op.in]: targetKeys } },
            ...(request.operation === 'set' || (this.associationType === 'HasOne' && request.operation === 'remove')
              ? [{ [relation.foreignKey]: sourceKey }]
              : []),
          ],
        };
        const records = await relation.targetModel.unscoped().findAll(
          internalQuery({
            where: candidateWhere,
            transaction,
            lock: transaction.LOCK.UPDATE,
            order: [[primary, 'ASC'] as [string, string]],
            limit: 1001,
          }),
        );
        current();
        if (records.length > 1000) invalid('Child mutation exceeds batch limit');
        if (
          this.associationType === 'HasOne' &&
          records.filter((record) => {
            const raw = record.getDataValue(relation.foreignKey);
            return raw != null && normalizeKeys([raw], relation.source)[0] === sourceKey;
          }).length > 1
        )
          invalid('HasOne source has multiple existing targets');
        // Lock candidates for UPDATE before reference checks take SHARE locks.
        // Otherwise competing parents can deadlock while upgrading the same child.
        if (targetKeys.length) {
          const scope = await entry?.targetReadScope();
          current();
          await this.references.authorizeTargets(
            ctx,
            target,
            authenticated,
            {
              keys: targetKeys,
              where: scope ? { [Op.and]: [request.targetReadWhere ?? {}, scope.where ?? {}] } : request.targetReadWhere,
              bind: request.targetReadBind,
            },
            transaction,
          );
        }
        current();
        const selected = new Set(targetKeys);
        const changes: Array<{ record: Model; key: string; value: string | null }> = [];
        for (const record of records) {
          const key = normalizeKeys([record.getDataValue(primary)], relation.target)[0];
          const raw = record.getDataValue(relation.foreignKey);
          const before = raw == null ? null : normalizeKeys([raw], relation.source)[0];
          const value =
            selected.has(key) && request.operation !== 'remove' ? sourceKey : before === sourceKey ? null : before;
          if (value !== before) changes.push({ record, key, value });
        }
        const beforeSource = sourcePlan.records[0];
        const scalars = Object.fromEntries(
          Object.entries(request.sourceValues ?? {}).filter(
            ([field]) => !(relation.sourceConfig.ownership.enabled && field === 'tenantId'),
          ),
        );
        if (!changes.length && !hasPersistedChanges(beforeSource, scalars))
          return {
            keys: [],
            affected: 0,
            ...(request.sourceValues === undefined ? {} : { sourceResult: { keys: [], affected: 0 } }),
          };
        const scope = changes.length ? await entry?.targetWriteScope() : undefined;
        current();
        const targetPlan = changes.length
          ? await this.mutations.authorizeReferenceSource(
              ctx,
              target,
              authenticated,
              {
                keys: changes.map((change) => change.key),
                where: scope ? { [Op.and]: [request.targetWhere ?? {}, scope.where ?? {}] } : request.targetWhere,
                bind: request.targetBind,
              },
              transaction,
            )
          : undefined;
        current();
        const changedByKey = new Map(changes.map((change) => [change.key, change]));
        const sourcePatch = sourcePlan.valuesFor(beforeSource);
        const sourceOwner = sourcePatch.tenantId ?? beforeSource.getDataValue('tenantId');
        const sourceProtected = snapshotProtectedValues(
          this.db,
          relation.source,
          sourcePlan.records,
          relation.sourceConfig.ownership.enabled ? ['tenantId'] : [],
        );
        const targetRecords = targetPlan?.records ?? [];
        const targetProtected = snapshotProtectedValues(this.db, relation.target, targetRecords, [
          relation.foreignKey,
          ...(relation.targetConfig.ownership.enabled ? ['tenantId'] : []),
        ]);
        const targetOwners = new Map(
          targetRecords.map((record) => [
            normalizeKeys([record.getDataValue(primary)], relation.target)[0],
            targetPlan!.valuesFor(record).tenantId ?? record.getDataValue('tenantId'),
          ]),
        );
        // Explicit lifecycle callers also capture a source event for relation-only changes.
        if (Object.keys(sourcePatch).length || afterPersist)
          await writeInContext('source', () =>
            guardRelationshipUpdate(
              this.db,
              [relation.source, relation.target],
              relation.source,
              sourceKey,
              transaction,
              current,
              () =>
                relation.source.repository.update({
                  filterByTk: sourceKey,
                  values: sourcePatch,
                  transaction,
                  ...(entry ? { context: ctx } : {}),
                }),
              !Object.keys(sourcePatch).length,
            ),
          );
        current();
        const writeOrder =
          this.associationType === 'HasOne'
            ? [...targetRecords].sort(
                (left, right) =>
                  Number(
                    changedByKey.get(normalizeKeys([left.getDataValue(primary)], relation.target)[0])!.value !== null,
                  ) -
                  Number(
                    changedByKey.get(normalizeKeys([right.getDataValue(primary)], relation.target)[0])!.value !== null,
                  ),
              )
            : targetRecords;
        for (const record of writeOrder) {
          const key = normalizeKeys([record.getDataValue(primary)], relation.target)[0];
          await writeInContext('target', () =>
            guardRelationshipUpdate(
              this.db,
              [relation.source, relation.target],
              relation.target,
              key,
              transaction,
              current,
              () =>
                relation.target.repository.update({
                  filterByTk: key,
                  values: { ...targetPlan!.valuesFor(record), [relation.foreignKey]: changedByKey.get(key)!.value },
                  transaction,
                  ...(entry ? { context: ctx } : {}),
                }),
            ),
          );
          current();
        }
        const stageFields = afterPersist
          ? [
              ...new Set([
                primary,
                relation.foreignKey,
                ...snapshotProtectedValues(this.db, relation.target, []).fields,
                ...(relation.targetConfig.ownership.enabled ? ['tenantId'] : []),
              ]),
            ]
          : [];
        const readStageTargets = async () => {
          const rows = await relation.targetModel.unscoped().findAll(
            internalQuery({
              where: {
                [Op.or]: [
                  { [relation.foreignKey]: sourceKey },
                  { [primary]: { [Op.in]: records.map((record) => record.getDataValue(primary)) } },
                ],
              },
              transaction,
              attributes: stageFields,
              order: [[primary, 'ASC'] as [string, string]],
              limit: 1001,
            }),
          );
          current();
          if (rows.length > 1000) invalid('Child persistence stage exceeds batch limit');
          return rows;
        };
        const stageRows = afterPersist ? await readStageTargets() : undefined;
        const stageProtected = stageRows && snapshotProtectedValues(this.db, relation.target, stageRows);
        const stageState = (rows: readonly Model[]) =>
          rows.map((record) => [
            record.getDataValue(primary),
            record.getDataValue(relation.foreignKey),
            ...(relation.targetConfig.ownership.enabled ? [record.getDataValue('tenantId')] : []),
          ]);
        const expectedStage = stageRows && cloneDeep(stageState(stageRows));
        await afterPersist?.call(entry);
        await validateWriteTransaction(this.db, transaction, true);
        current();
        const afterSource = await relation.sourceModel.unscoped().findAll(
          internalQuery({
            where: { [relation.sourceModel.primaryKeyAttribute]: sourceKey },
            transaction,
          }),
        );
        current();
        const after = await relation.targetModel.unscoped().findAll(
          internalQuery({
            where: { [primary]: { [Op.in]: changes.map((change) => change.key) } },
            transaction,
          }),
        );
        current();
        if (afterSource.length !== 1 || after.length !== changes.length) invalid('Writer removed a relation record');
        sourceProtected.verify(afterSource);
        targetProtected.verify(after);
        if (relation.sourceConfig.ownership.enabled && afterSource[0].getDataValue('tenantId') !== sourceOwner)
          throw new AccessMutationError('ACCESS_OWNERSHIP_CHANGE_FORBIDDEN', 'Writer changed source ownership');
        for (const record of after) {
          const key = normalizeKeys([record.getDataValue(primary)], relation.target)[0];
          if (relation.targetConfig.ownership.enabled && record.getDataValue('tenantId') !== targetOwners.get(key))
            throw new AccessMutationError('ACCESS_OWNERSHIP_CHANGE_FORBIDDEN', 'Writer changed target ownership');
          const raw = record.getDataValue(relation.foreignKey);
          if ((raw == null ? null : normalizeKeys([raw], relation.source)[0]) !== changedByKey.get(key)!.value)
            invalid('Writer did not set the authorized child foreign key');
        }
        if (stageProtected) {
          const actual = await readStageTargets();
          if (!isDeepStrictEqual(stageState(actual), expectedStage))
            invalid('Persistence stage changed authorized child connections or ownership');
          stageProtected.verify(actual);
        }
        return {
          keys: targetRecords.map((record) => record.getDataValue(primary) as string | number),
          affected: changes.length,
          ...(request.sourceValues === undefined
            ? {}
            : {
                sourceResult: {
                  keys: [beforeSource.getDataValue(relation.sourceModel.primaryKeyAttribute) as string | number],
                  affected: 1,
                },
              }),
        };
      };
      return inheritedTransaction
        ? await execute(inheritedTransaction)
        : await this.db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, execute);
    } catch (error) {
      const conflict = error as { original?: { code?: string }; parent?: { code?: string } };
      if (['40001', '40P01'].includes(conflict?.original?.code ?? conflict?.parent?.code ?? ''))
        throw new AccessMutationError(
          'ACCESS_MUTATION_CONFLICT',
          'Concurrent authorization changed; retry the operation',
          409,
        );
      throw error;
    }
  }
}
