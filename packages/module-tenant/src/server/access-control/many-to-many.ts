import { isDeepStrictEqual } from 'node:util';
import {
  Op,
  Transaction,
  type BelongsToManyRepository,
  type Database,
  type Model,
  type WhereOptions,
} from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { guardJoinWrite } from './join-write-guard';
import { resolveManyToMany } from './many-to-many-metadata';
import type { AccessMutationService } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  plain,
  snapshotProtectedValues,
  validateWriteTransaction,
} from './write-support';

export interface ManyToManyWriteRequest {
  association: string;
  operation: 'add' | 'remove' | 'set';
  sourceKeys: Array<string | number>;
  targetKeys: Array<string | number>;
  /** Server-parsed predicates; entry adapters also check action and field permissions. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
}

/** Only changes join rows and an optional legacy-source claim; never edits/deletes targets. */
export class AccessManyToManyService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly mutations: AccessMutationService,
    private readonly references: AccessReferenceService,
  ) {}

  async withLinks(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    through: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyWriteRequest,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    source = { ...source };
    target = { ...target };
    through = { ...through };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    if (this.db.sequelize.getDialect() !== 'postgres')
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relationship writes require PostgreSQL', 400);
    const allowed = [
      'association',
      'operation',
      'sourceKeys',
      'targetKeys',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
    ];
    if (!plain(request) || Reflect.ownKeys(request).some((key) => typeof key !== 'string' || !allowed.includes(key)))
      invalid('Unsupported link mutation input');
    if (!['add', 'remove', 'set'].includes(request.operation)) invalid('Unsupported link operation');
    const relation = resolveManyToMany(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      source,
      target,
      through,
      request.association,
    );
    const sourceKeys = normalizeKeys(request.sourceKeys, relation.source);
    const targetKeys =
      Array.isArray(request.targetKeys) && request.targetKeys.length === 0
        ? []
        : normalizeKeys(request.targetKeys, relation.target);
    if (sourceKeys.length * targetKeys.length > 10000) invalid('Link mutation exceeds batch limit');
    try {
      return await this.db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          await validateWriteTransaction(this.db, transaction, true);
          const plan = await this.mutations.authorizeReferenceSource(
            ctx,
            source,
            authenticated,
            {
              keys: sourceKeys,
              where: request.sourceWhere,
              bind: request.sourceBind,
            },
            transaction,
          );
          relation.current();
          if (targetKeys.length)
            await this.references.authorizeTargets(
              ctx,
              target,
              authenticated,
              {
                keys: targetKeys,
                where: { [Op.and]: [relation.scope ?? {}, request.targetWhere ?? {}] },
                bind: request.targetBind,
              },
              transaction,
            );
          relation.current();
          const primary = relation.sourceModel.primaryKeyAttribute;
          const readLinks = async () => {
            const rows = await relation.throughModel.unscoped().findAll(
              internalQuery({
                where: { [relation.foreignKey]: { [Op.in]: sourceKeys } },
                transaction,
                order: [
                  [relation.foreignKey, 'ASC'] as [string, string],
                  [relation.otherKey, 'ASC'] as [string, string],
                ],
                lock: transaction.LOCK.UPDATE,
                limit: 10001,
              }),
            );
            relation.current();
            if (rows.length > 10000) invalid('Link mutation exceeds batch limit');
            const grouped = new Map(sourceKeys.map((key) => [key, new Set<string>()]));
            for (const row of rows) {
              const owner = normalizeKeys([row.getDataValue(relation.foreignKey)], relation.source)[0];
              const key = normalizeKeys([row.getDataValue(relation.otherKey)], relation.target)[0];
              const set = grouped.get(owner);
              if (!set || set.has(key)) invalid('Join table contains an invalid or duplicate connection');
              set.add(key);
            }
            return grouped;
          };
          const before = await readLinks();
          const expected = new Map<string, Set<string>>();
          const changes: Array<{ record: Model; key: string; add: string[]; remove: string[] }> = [];
          for (const record of plan.records) {
            const key = normalizeKeys([record.getDataValue(primary)], relation.source)[0];
            const old = before.get(key)!;
            const desired = request.operation === 'set' ? new Set(targetKeys) : new Set(old);
            if (request.operation === 'add') for (const id of targetKeys) desired.add(id);
            if (request.operation === 'remove') for (const id of targetKeys) desired.delete(id);
            expected.set(key, desired);
            const add = [...desired].filter((id) => !old.has(id));
            const remove = [...old].filter((id) => !desired.has(id));
            if (add.length || remove.length) changes.push({ record, key, add, remove });
          }
          const protectedValues = snapshotProtectedValues(
            this.db,
            relation.source,
            plan.records,
            relation.sourceConfig.ownership.enabled ? ['tenantId'] : [],
          );
          const changed = new Set(changes.map((change) => change.key));
          const owners = new Map(
            plan.records.map((record) => {
              const key = normalizeKeys([record.getDataValue(primary)], relation.source)[0];
              return [
                key,
                changed.has(key)
                  ? (plan.valuesFor(record).tenantId ?? record.getDataValue('tenantId'))
                  : record.getDataValue('tenantId'),
              ];
            }),
          );
          for (const change of changes) {
            const patch = plan.valuesFor(change.record);
            if (Object.keys(patch).length)
              await relation.source.repository.update({
                filterByTk: change.record.getDataValue(primary),
                values: patch,
                transaction,
              });
            const repository = relation.source.repository
              .relation<BelongsToManyRepository>(request.association)
              .of(change.record.getDataValue(primary));
            for (const operation of ['remove', 'add'] as const) {
              const targetKeys = change[operation];
              if (!targetKeys.length) continue;
              const current = () => {
                relation.current();
                if (
                  operation === 'remove' &&
                  (this.db.referenceMap.getReferences(relation.through.name) ?? []).some(
                    (reference) => !['NO ACTION', 'RESTRICT'].includes(reference.onDelete),
                  )
                )
                  throw new AccessMutationError(
                    'UNSUPPORTED_ACCESS_MUTATION',
                    'Cascaded join writes require their own adapters',
                    400,
                  );
              };
              current();
              await guardJoinWrite(
                this.db,
                relation.source,
                relation.target,
                relation.through,
                relation.foreignKey,
                relation.otherKey,
                transaction,
                { operation, sourceKey: change.key, targetKeys },
                current,
                () => repository[operation]({ tk: targetKeys, transaction }),
              );
            }
            relation.current();
          }
          await validateWriteTransaction(this.db, transaction, true);
          relation.current();
          const actual = await readLinks();
          for (const key of sourceKeys)
            if (!isDeepStrictEqual(actual.get(key), expected.get(key)))
              invalid('Writer changed unauthorized connections');
          const after = await relation.sourceModel.unscoped().findAll(
            internalQuery({
              where: { [primary]: { [Op.in]: sourceKeys } },
              transaction,
            }),
          );
          relation.current();
          if (after.length !== sourceKeys.length) invalid('Writer removed a relation source');
          protectedValues.verify(after);
          if (
            relation.sourceConfig.ownership.enabled &&
            after.some(
              (record) =>
                record.getDataValue('tenantId') !==
                owners.get(normalizeKeys([record.getDataValue(primary)], relation.source)[0]),
            )
          )
            throw new AccessMutationError('ACCESS_OWNERSHIP_CHANGE_FORBIDDEN', 'Writer changed source ownership');
          return {
            keys: changes.map((change) => change.record.getDataValue(primary) as string | number),
            affected: changes.length,
          };
        },
      );
    } catch (error) {
      const conflict = error as { original?: { code?: string }; parent?: { code?: string } };
      if ((conflict?.original?.code ?? conflict?.parent?.code) === '40001')
        throw new AccessMutationError(
          'ACCESS_MUTATION_CONFLICT',
          'Concurrent authorization changed; retry the operation',
          409,
        );
      throw error;
    }
  }
}
