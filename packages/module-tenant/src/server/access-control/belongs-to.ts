import { Op, Transaction, type Database, type Model, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessMutationService, ExistingAccessWritePlan } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import type { AccessReferenceService, BelongsToReadRequest } from './references';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  snapshotProtectedValues,
  validateWriteTransaction,
} from './write-support';

export interface BelongsToWriteRequest
  extends Pick<BelongsToReadRequest, 'association' | 'sourceWhere' | 'sourceBind' | 'targetWhere' | 'targetBind'> {
  sourceKeys: Array<string | number>;
  targetKey: string | number | null;
}

/** Changes only a source foreign key. Target edits/deletes need a separate G write plan. */
export class AccessBelongsToService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly mutations: AccessMutationService,
    private readonly references: AccessReferenceService,
  ) {}

  async withReference(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToWriteRequest,
    writer: (plan: ExistingAccessWritePlan) => Promise<unknown>,
    entry?: {
      assertCurrent(): void;
      /** Trusted entry callback, invoked only for a changed, non-null reference under the source lock. */
      targetScope(): Promise<{ where?: WhereOptions }>;
    },
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    if (this.db.sequelize.getDialect() !== 'postgres')
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relationship writes require PostgreSQL', 400);
    const relation = resolveBelongsTo(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      source,
      target,
      request.association,
      true,
    );
    const targetKey = request.targetKey === null ? null : normalizeKeys([request.targetKey], relation.target)[0];
    const current = () => {
      relation.current();
      entry?.assertCurrent();
    };
    current();
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
            {
              keys: request.sourceKeys,
              where: request.sourceWhere,
              bind: request.sourceBind,
            },
            transaction,
          );
          current();
          const changed = sourcePlan.records.some((record) => {
            const existing = record.getDataValue(relation.foreignKey);
            return (existing == null ? null : normalizeKeys([existing], relation.target)[0]) !== targetKey;
          });
          // Preserve low-level callers' explicit target constraints; only the finalized entry opts into
          // treating an unchanged value as an existing reference rather than a new target selection.
          if (targetKey !== null && (changed || !entry)) {
            const targetScope = await entry?.targetScope();
            current();
            await this.references.authorizeTargets(
              ctx,
              target,
              authenticated,
              {
                keys: [targetKey],
                where: { [Op.and]: [relation.scope ?? {}, request.targetWhere ?? {}, targetScope?.where ?? {}] },
                bind: request.targetBind,
              },
              transaction,
            );
          }
          current();
          const primary = relation.sourceModel.primaryKeyAttribute;
          const keys = sourcePlan.records.map((record) => record.getDataValue(primary) as string | number);
          const owners = new Map(
            sourcePlan.records.map((record) => [
              String(record.getDataValue(primary)),
              sourcePlan.valuesFor(record).tenantId ?? record.getDataValue('tenantId'),
            ]),
          );
          const plan: ExistingAccessWritePlan = Object.freeze({
            records: sourcePlan.records,
            transaction,
            valuesFor: (record: Model) => ({ ...sourcePlan.valuesFor(record), [relation.foreignKey]: targetKey }),
          });
          const protectedValues = snapshotProtectedValues(this.db, relation.source, sourcePlan.records, [
            relation.foreignKey,
            ...(relation.sourceConfig.ownership.enabled ? ['tenantId'] : []),
          ]);
          await writer(plan);
          await validateWriteTransaction(this.db, transaction, true);
          current();
          const after = await relation.sourceModel.unscoped().findAll(
            internalQuery({
              where: { [primary]: { [Op.in]: keys } },
              transaction,
              attributes: [
                ...new Set([
                  primary,
                  relation.foreignKey,
                  ...(relation.sourceConfig.ownership.enabled ? ['tenantId'] : []),
                  ...protectedValues.fields,
                ]),
              ],
            }),
          );
          current();
          if (after.length !== keys.length) invalid('Writer removed a relation source');
          protectedValues.verify(after);
          for (const record of after) {
            if (
              relation.sourceConfig.ownership.enabled &&
              record.getDataValue('tenantId') !== owners.get(String(record.getDataValue(primary)))
            )
              throw new AccessMutationError('ACCESS_OWNERSHIP_CHANGE_FORBIDDEN', 'Writer changed source ownership');
            const actual = record.getDataValue(relation.foreignKey);
            if ((actual == null ? null : normalizeKeys([actual], relation.target)[0]) !== targetKey)
              invalid('Writer did not set the authorized foreign key');
          }
          return { keys, affected: keys.length };
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
