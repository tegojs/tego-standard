import { Op, Transaction, type Database, type Model, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessMutationService, ExistingAccessWritePlan } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import type { AccessReferenceService, BelongsToReadRequest } from './references';
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

export interface BelongsToWriteRequest
  extends Pick<BelongsToReadRequest, 'association' | 'sourceWhere' | 'sourceBind' | 'targetWhere' | 'targetBind'> {
  sourceKeys: Array<string | number>;
  targetKey: string | number | null;
  /** Scalar source patch, already sanitized by the entry's finalized field permissions. */
  sourceValues?: Record<string, unknown>;
}

export const MAX_REFERENCE_UPDATES = 20;

export interface BelongsToReferenceUpdate
  extends Pick<BelongsToWriteRequest, 'association' | 'targetKey' | 'targetWhere' | 'targetBind'> {
  target: AccessCollectionIdentity;
}

export interface BelongsToReferencesWriteRequest
  extends Pick<BelongsToWriteRequest, 'sourceKeys' | 'sourceWhere' | 'sourceBind' | 'sourceValues'> {
  references: BelongsToReferenceUpdate[];
}

export interface BelongsToReferencesWriteEntry {
  assertCurrent(): void;
  /** Called independently for each changed, non-null reference under the source lock. */
  targetScope(index: number): Promise<{ where?: WhereOptions }>;
}

/** Changes source references and an optional scalar patch. Never edits targets. */
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
    request = cloneDeep(request);
    return this.withReferences(
      ctx,
      source,
      authenticated,
      {
        sourceKeys: request.sourceKeys,
        sourceWhere: request.sourceWhere,
        sourceBind: request.sourceBind,
        sourceValues: request.sourceValues,
        references: [
          {
            target,
            association: request.association,
            targetKey: request.targetKey,
            targetWhere: request.targetWhere,
            targetBind: request.targetBind,
          },
        ],
      },
      writer,
      entry,
    );
  }

  async withReferences(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToReferencesWriteRequest,
    writer: (plan: ExistingAccessWritePlan) => Promise<unknown>,
    entry?: BelongsToReferencesWriteEntry,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    return this.writeReferences(ctx, source, authenticated, request, writer, entry);
  }

  /** The caller owns commit/rollback and must roll back the whole transaction on any error. */
  async withReferencesInTransaction(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToReferencesWriteRequest,
    transaction: Transaction,
    writer: (plan: ExistingAccessWritePlan) => Promise<unknown>,
    entry?: BelongsToReferencesWriteEntry,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    if (!(transaction instanceof Transaction)) invalid('An active root write transaction is required');
    return this.writeReferences(ctx, source, authenticated, request, writer, entry, transaction);
  }

  private async writeReferences(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToReferencesWriteRequest,
    writer: (plan: ExistingAccessWritePlan) => Promise<unknown>,
    entry?: BelongsToReferencesWriteEntry,
    inheritedTransaction?: Transaction,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    source = { ...source };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    if (this.db.sequelize.getDialect() !== 'postgres')
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relationship writes require PostgreSQL', 400);
    if (
      !Array.isArray(request.references) ||
      Object.getPrototypeOf(request.references) !== Array.prototype ||
      !request.references.length ||
      request.references.length > MAX_REFERENCE_UPDATES ||
      Reflect.ownKeys(request.references).length !== request.references.length + 1 ||
      Array.from({ length: request.references.length }, (_, index) => index).some(
        (index) => !Object.hasOwn(request.references, index),
      )
    )
      invalid('Reference updates require between 1 and 20 references in a dense list');
    const names = new Set<string>();
    const references = request.references.map((reference) => {
      if (!plain(reference) || typeof reference.association !== 'string' || names.has(reference.association))
        invalid('Reference updates require distinct registered association names');
      names.add(reference.association);
      const relation = resolveBelongsTo(
        this.db,
        this.prepared,
        this.queries,
        ctx,
        source,
        reference.target,
        reference.association,
        true,
      );
      const targetKey = reference.targetKey === null ? null : normalizeKeys([reference.targetKey], relation.target)[0];
      return { reference, relation, targetKey };
    });
    const relation = references[0].relation;
    const metadata = accessMetadataGuard(
      this.db,
      [
        { model: relation.sourceModel, config: relation.sourceConfig },
        ...references.map(({ relation }) => ({ model: relation.targetModel, config: relation.targetConfig })),
      ],
      references.map(({ reference }) => ({ model: relation.sourceModel, path: [reference.association] })),
    );
    const current = () => {
      for (const reference of references) reference.relation.current();
      metadata();
      entry?.assertCurrent();
    };
    current();
    try {
      const execute = async (transaction: Transaction) => {
        await validateWriteTransaction(this.db, transaction, true);
        current();
        const sourceRequest = {
          keys: request.sourceKeys,
          where: request.sourceWhere,
          bind: request.sourceBind,
        };
        const sourcePlan =
          request.sourceValues === undefined
            ? await this.mutations.authorizeReferenceSource(ctx, source, authenticated, sourceRequest, transaction)
            : await this.mutations.authorizeExisting(
                ctx,
                source,
                authenticated,
                { ...sourceRequest, operation: 'update', values: request.sourceValues },
                transaction,
              );
        current();
        const changes = references.map(({ relation, targetKey }) => {
          return sourcePlan.records.some((record) => {
            const existing = record.getDataValue(relation.foreignKey);
            return (existing == null ? null : normalizeKeys([existing], relation.target)[0]) !== targetKey;
          });
        });
        // Preserve low-level callers' explicit target constraints; only the finalized entry opts into
        // treating an unchanged value as an existing reference rather than a new target selection.
        for (const [index, { reference, relation, targetKey }] of references.entries()) {
          if (targetKey !== null && (changes[index] || !entry)) {
            const targetScope = await entry?.targetScope(index);
            current();
            await this.references.authorizeTargets(
              ctx,
              reference.target,
              authenticated,
              {
                keys: [targetKey],
                where: { [Op.and]: [relation.scope ?? {}, reference.targetWhere ?? {}, targetScope?.where ?? {}] },
                bind: reference.targetBind,
              },
              transaction,
            );
            current();
          }
        }
        current();
        // A finalized form save with no business change must not claim a historical source.
        // Low-level callers retain their existing explicit write/target-validation contract.
        const scalarValues = Object.fromEntries(
          Object.entries(request.sourceValues ?? {}).filter(
            ([field]) => !(relation.sourceConfig.ownership.enabled && field === 'tenantId'),
          ),
        );
        const records = entry
          ? sourcePlan.records.filter(
              (record) =>
                hasPersistedChanges(record, scalarValues) ||
                references.some(({ relation, targetKey }) => {
                  const existing = record.getDataValue(relation.foreignKey);
                  return (existing == null ? null : normalizeKeys([existing], relation.target)[0]) !== targetKey;
                }),
            )
          : sourcePlan.records;
        if (!records.length) return { keys: [], affected: 0 };
        const primary = relation.sourceModel.primaryKeyAttribute;
        const keys = records.map((record) => record.getDataValue(primary) as string | number);
        const owners = new Map(
          records.map((record) => [
            String(record.getDataValue(primary)),
            sourcePlan.valuesFor(record).tenantId ?? record.getDataValue('tenantId'),
          ]),
        );
        const plan: ExistingAccessWritePlan = Object.freeze({
          records: Object.freeze(records),
          transaction,
          valuesFor: (record: Model) => ({
            ...sourcePlan.valuesFor(record),
            ...Object.fromEntries(references.map(({ relation, targetKey }) => [relation.foreignKey, targetKey])),
          }),
        });
        const protectedValues = snapshotProtectedValues(this.db, relation.source, records, [
          ...references.map(({ relation }) => relation.foreignKey),
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
                ...references.map(({ relation }) => relation.foreignKey),
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
          for (const { relation, targetKey } of references) {
            const actual = record.getDataValue(relation.foreignKey);
            if ((actual == null ? null : normalizeKeys([actual], relation.target)[0]) !== targetKey)
              invalid('Writer did not set the authorized foreign key');
          }
        }
        return { keys, affected: keys.length };
      };
      return inheritedTransaction
        ? await execute(inheritedTransaction)
        : await this.db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, execute);
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
