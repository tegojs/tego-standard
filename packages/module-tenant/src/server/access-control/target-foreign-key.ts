import { Op, Transaction, type Database, type Model, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessMutationService } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
import { guardRelationshipUpdate } from './relationship-write-guard';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import {
  cloneDeep,
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
  targetReadScope(): Promise<{ where?: WhereOptions }>;
  targetWriteScope(): Promise<{ where?: WhereOptions }>;
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
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    if (this.db.sequelize.getDialect() !== 'postgres')
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relationship writes require PostgreSQL', 400);
    const allowed = [
      'association',
      'operation',
      'sourceKey',
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
    const current = () => {
      relation.current();
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
      return await this.db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          await validateWriteTransaction(this.db, transaction, true);
          current();
          const sourcePlan = await this.mutations.authorizeReferenceSource(
            ctx,
            source,
            authenticated,
            { keys: [sourceKey], where: request.sourceWhere, bind: request.sourceBind },
            transaction,
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
                where: scope
                  ? { [Op.and]: [request.targetReadWhere ?? {}, scope.where ?? {}] }
                  : request.targetReadWhere,
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
          if (!changes.length) return { keys: [], affected: 0 };
          const scope = await entry?.targetWriteScope();
          current();
          const targetPlan = await this.mutations.authorizeReferenceSource(
            ctx,
            target,
            authenticated,
            {
              keys: changes.map((change) => change.key),
              where: scope ? { [Op.and]: [request.targetWhere ?? {}, scope.where ?? {}] } : request.targetWhere,
              bind: request.targetBind,
            },
            transaction,
          );
          current();
          const changedByKey = new Map(changes.map((change) => [change.key, change]));
          const beforeSource = sourcePlan.records[0];
          const sourcePatch = sourcePlan.valuesFor(beforeSource);
          const sourceOwner = sourcePatch.tenantId ?? beforeSource.getDataValue('tenantId');
          const sourceProtected = snapshotProtectedValues(
            this.db,
            relation.source,
            sourcePlan.records,
            relation.sourceConfig.ownership.enabled ? ['tenantId'] : [],
          );
          const targetProtected = snapshotProtectedValues(this.db, relation.target, targetPlan.records, [
            relation.foreignKey,
            ...(relation.targetConfig.ownership.enabled ? ['tenantId'] : []),
          ]);
          const targetOwners = new Map(
            targetPlan.records.map((record) => [
              normalizeKeys([record.getDataValue(primary)], relation.target)[0],
              targetPlan.valuesFor(record).tenantId ?? record.getDataValue('tenantId'),
            ]),
          );
          if (Object.keys(sourcePatch).length)
            await guardRelationshipUpdate(
              this.db,
              [relation.source, relation.target],
              relation.source,
              sourceKey,
              transaction,
              current,
              () =>
                relation.source.repository.update({
                  filterByTk: beforeSource.getDataValue(relation.sourceModel.primaryKeyAttribute),
                  values: sourcePatch,
                  transaction,
                  ...(entry ? { context: ctx } : {}),
                }),
            );
          current();
          const writeOrder =
            this.associationType === 'HasOne'
              ? [...targetPlan.records].sort(
                  (left, right) =>
                    Number(
                      changedByKey.get(normalizeKeys([left.getDataValue(primary)], relation.target)[0])!.value !== null,
                    ) -
                    Number(
                      changedByKey.get(normalizeKeys([right.getDataValue(primary)], relation.target)[0])!.value !==
                        null,
                    ),
                )
              : targetPlan.records;
          for (const record of writeOrder) {
            const key = normalizeKeys([record.getDataValue(primary)], relation.target)[0];
            await guardRelationshipUpdate(
              this.db,
              [relation.source, relation.target],
              relation.target,
              key,
              transaction,
              current,
              () =>
                relation.target.repository.update({
                  filterByTk: record.getDataValue(primary),
                  values: { ...targetPlan.valuesFor(record), [relation.foreignKey]: changedByKey.get(key)!.value },
                  transaction,
                  ...(entry ? { context: ctx } : {}),
                }),
            );
            current();
          }
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
          return {
            keys: targetPlan.records.map((record) => record.getDataValue(primary) as string | number),
            affected: changes.length,
          };
        },
      );
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
