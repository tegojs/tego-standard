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
import { resolveBelongsTo } from './association-metadata';
import { captureUserAuditFields } from './audit-fields';
import { MAX_REFERENCE_UPDATES, type BelongsToReferenceUpdate } from './belongs-to';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { guardJoinWrite } from './join-write-guard';
import { resolveManyToMany } from './many-to-many-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessMutationSelection, AccessMutationService } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
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

export interface ManyToManyWriteRequest {
  association: string;
  operation: 'add' | 'remove' | 'set';
  sourceKeys: Array<string | number>;
  targetKeys: Array<string | number>;
  /** Server-parsed predicates; entry adapters also check action and field permissions. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  /** Sanitized scalar patch authorized by the same finalized root update permission. */
  sourceValues?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
}

export interface ManyToManyLinkSet
  extends Pick<ManyToManyWriteRequest, 'association' | 'operation' | 'targetKeys' | 'targetWhere' | 'targetBind'> {
  target: AccessCollectionIdentity;
  through: AccessCollectionIdentity;
}

export interface ManyToManyLinkSetsRequest
  extends Pick<ManyToManyWriteRequest, 'sourceKeys' | 'sourceWhere' | 'sourceBind' | 'sourceValues'> {
  links: ManyToManyLinkSet[];
  /** Existing single-value references saved with the same source authorization and transaction. */
  references?: BelongsToReferenceUpdate[];
  /** Preserve a configured workflow node's source update hook behavior. */
  individualHooks?: boolean;
}

export interface ManyToManyLinkSetsWriteEntry {
  assertCurrent(): void;
  sourceScope?: AccessMutationSelection;
  targetScope(index: number): Promise<{ where?: WhereOptions }>;
  referenceScope?(index: number): Promise<{ where?: WhereOptions }>;
  authorizeChanges?(index: number, keys: string[], transaction: Transaction): Promise<void>;
  /** Explicit source lifecycle stage, after all links persist and before final verification. */
  afterPersist?(): Promise<void>;
}

/** Changes pure join rows and an optional source patch; never edits/deletes targets. */
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
    entry?: {
      assertCurrent(): void;
      sourceScope?: AccessMutationSelection;
      targetScope(): Promise<{ where?: WhereOptions }>;
      /** Trusted finalized action predicates on every actual addition/removal, including set removals. */
      authorizeChanges?(keys: string[], transaction: Transaction): Promise<void>;
    },
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    source = { ...source };
    target = { ...target };
    through = { ...through };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    const allowed = [
      'association',
      'operation',
      'sourceKeys',
      'targetKeys',
      'sourceWhere',
      'sourceBind',
      'sourceValues',
      'targetWhere',
      'targetBind',
    ];
    if (!plain(request) || Reflect.ownKeys(request).some((key) => typeof key !== 'string' || !allowed.includes(key)))
      invalid('Unsupported link mutation input');
    return this.withLinkSets(
      ctx,
      source,
      authenticated,
      {
        sourceKeys: request.sourceKeys,
        sourceWhere: request.sourceWhere,
        sourceBind: request.sourceBind,
        sourceValues: request.sourceValues,
        links: [
          {
            target,
            through,
            association: request.association,
            operation: request.operation,
            targetKeys: request.targetKeys,
            targetWhere: request.targetWhere,
            targetBind: request.targetBind,
          },
        ],
      },
      entry && {
        assertCurrent: () => entry.assertCurrent(),
        sourceScope: entry.sourceScope,
        targetScope: () => entry.targetScope(),
        ...(entry.authorizeChanges
          ? {
              authorizeChanges: (_index: number, keys: string[], transaction: Transaction) =>
                entry.authorizeChanges!(keys, transaction),
            }
          : {}),
      },
    );
  }

  async withLinkSets(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyLinkSetsRequest,
    entry?: ManyToManyLinkSetsWriteEntry,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    return this.writeLinkSets(ctx, source, authenticated, request, entry);
  }

  /** The caller owns commit/rollback and must roll back the whole transaction on any error. */
  async withLinkSetsInTransaction(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyLinkSetsRequest,
    transaction: Transaction,
    entry?: ManyToManyLinkSetsWriteEntry,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    if (!(transaction instanceof Transaction)) invalid('An active root write transaction is required');
    return this.writeLinkSets(ctx, source, authenticated, request, entry, transaction);
  }

  private async writeLinkSets(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyLinkSetsRequest,
    entry?: ManyToManyLinkSetsWriteEntry,
    inheritedTransaction?: Transaction,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    source = { ...source };
    authenticated = { ...authenticated };
    const original = request;
    request = cloneDeep(request);
    if (this.db.sequelize.getDialect() !== 'postgres')
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relationship writes require PostgreSQL', 400);
    const afterPersist = entry?.afterPersist;
    if (afterPersist !== undefined && typeof afterPersist !== 'function')
      invalid('A persistence stage must be a function');
    if (
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          ![
            'sourceKeys',
            'sourceWhere',
            'sourceBind',
            'sourceValues',
            'links',
            'references',
            'individualHooks',
          ].includes(key),
      )
    )
      invalid('Unsupported link mutation input');
    if (request.individualHooks !== undefined && typeof request.individualHooks !== 'boolean')
      invalid('Link source individualHooks must be a boolean');
    if (
      !Array.isArray(request.links) ||
      Object.getPrototypeOf(original.links) !== Array.prototype ||
      !request.links.length ||
      request.links.length > MAX_REFERENCE_UPDATES ||
      Reflect.ownKeys(request.links).length !== request.links.length + 1 ||
      Array.from({ length: request.links.length }, (_, index) => index).some(
        (index) => !Object.hasOwn(request.links, index),
      )
    )
      invalid('Link updates require between 1 and 20 entries in a dense list');
    const names = new Set<string>();
    const joins = new Set<ReturnType<typeof resolveManyToMany>['throughModel']>();
    const sets = request.links.map((link, index) => {
      if (
        !plain(link) ||
        typeof link.association !== 'string' ||
        names.has(link.association) ||
        Reflect.ownKeys(link).some(
          (key) =>
            typeof key !== 'string' ||
            !['target', 'through', 'association', 'operation', 'targetKeys', 'targetWhere', 'targetBind'].includes(key),
        )
      )
        invalid('Link updates require distinct registered association names');
      names.add(link.association);
      if (!['add', 'remove', 'set'].includes(link.operation)) invalid('Unsupported link operation');
      const relation = resolveManyToMany(
        this.db,
        this.prepared,
        this.queries,
        ctx,
        source,
        link.target,
        link.through,
        link.association,
      );
      if (joins.has(relation.throughModel)) invalid('Link updates cannot replace overlapping join tables');
      joins.add(relation.throughModel);
      if (
        !Array.isArray(link.targetKeys) ||
        Object.getPrototypeOf(original.links[index].targetKeys) !== Array.prototype ||
        Reflect.ownKeys(link.targetKeys).length !== link.targetKeys.length + 1 ||
        Array.from({ length: link.targetKeys.length }, (_, index) => index).some(
          (index) => !Object.hasOwn(link.targetKeys, index),
        )
      )
        invalid('Link targets require a dense key array');
      const targetKeys = link.targetKeys.length ? normalizeKeys(link.targetKeys, relation.target) : [];
      return { index, link, relation, targetKeys };
    });
    const relation = sets[0].relation;
    if (
      request.references !== undefined &&
      (!Array.isArray(request.references) ||
        Object.getPrototypeOf(original.references) !== Array.prototype ||
        request.references.length + sets.length > MAX_REFERENCE_UPDATES ||
        Reflect.ownKeys(request.references).length !== request.references.length + 1 ||
        Array.from({ length: request.references.length }, (_, index) => index).some(
          (index) => !Object.hasOwn(request.references, index),
        ))
    )
      invalid('Mixed reference updates require a bounded dense list');
    if (request.references?.length && entry && !entry.referenceScope)
      invalid('Mixed reference updates require independent reference permissions');
    const foreignKeys = new Set<string>();
    const references = (request.references ?? []).map((reference) => {
      if (
        !plain(reference) ||
        typeof reference.association !== 'string' ||
        names.has(reference.association) ||
        Reflect.ownKeys(reference).some(
          (key) =>
            typeof key !== 'string' ||
            !['association', 'target', 'targetKey', 'targetWhere', 'targetBind'].includes(key),
        )
      )
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
      if (foreignKeys.has(relation.foreignKey)) invalid('Reference updates cannot replace overlapping foreign keys');
      foreignKeys.add(relation.foreignKey);
      const targetKey = reference.targetKey === null ? null : normalizeKeys([reference.targetKey], relation.target)[0];
      return { reference, relation, targetKey };
    });
    const metadata = accessMetadataGuard(
      this.db,
      [
        { model: relation.sourceModel, config: relation.sourceConfig },
        ...sets.map(({ link, relation }) => ({
          model: relation.targetModel,
          config: this.prepared.configuration(ctx, link.target)!,
        })),
        ...references.map(({ relation }) => ({ model: relation.targetModel, config: relation.targetConfig })),
      ],
      [...sets.map(({ link }) => link.association), ...references.map(({ reference }) => reference.association)].map(
        (association) => ({ model: relation.sourceModel, path: [association] }),
      ),
    );
    const current = () => {
      for (const set of sets) set.relation.current();
      for (const reference of references) reference.relation.current();
      metadata();
      entry?.assertCurrent();
    };
    current();
    const sourceKeys = normalizeKeys(request.sourceKeys, relation.source);
    if (sourceKeys.length * sets.reduce((total, set) => total + set.targetKeys.length, 0) > 10000)
      invalid('Link mutation exceeds batch limit');
    const ordered = [...sets].sort((a, b) => {
      const left = a.link.through.collectionKey;
      const right = b.link.through.collectionKey;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    try {
      const execute = async (transaction: Transaction) => {
        await validateWriteTransaction(this.db, transaction, true);
        current();
        const sourceRequest = {
          keys: sourceKeys,
          where: request.sourceWhere,
          bind: request.sourceBind,
        };
        const plan =
          request.sourceValues === undefined
            ? await this.mutations.authorizeReferenceSource(
                ctx,
                source,
                authenticated,
                sourceRequest,
                transaction,
                entry?.sourceScope,
              )
            : await this.mutations.authorizeExisting(
                ctx,
                source,
                authenticated,
                { ...sourceRequest, operation: 'update', values: request.sourceValues },
                transaction,
                entry?.sourceScope,
              );
        current();
        const referenceChanges = new Set<string>();
        for (const [index, { reference, relation, targetKey }] of references.entries()) {
          const changed = plan.records.filter((record) => {
            const old = record.getDataValue(relation.foreignKey);
            return (old == null ? null : normalizeKeys([old], relation.target)[0]) !== targetKey;
          });
          for (const record of changed)
            referenceChanges.add(
              normalizeKeys([record.getDataValue(relation.sourceModel.primaryKeyAttribute)], relation.source)[0],
            );
          if (targetKey !== null && (changed.length || !entry)) {
            const scope = await entry?.referenceScope?.(index);
            current();
            await this.references.authorizeTargets(
              ctx,
              reference.target,
              authenticated,
              {
                keys: [targetKey],
                where: { [Op.and]: [relation.scope ?? {}, reference.targetWhere ?? {}, scope?.where ?? {}] },
                bind: reference.targetBind,
              },
              transaction,
            );
            current();
          }
        }
        for (const { link, relation, targetKeys } of ordered) {
          if (targetKeys.length && !entry)
            await this.references.authorizeTargets(
              ctx,
              link.target,
              authenticated,
              {
                keys: targetKeys,
                where: { [Op.and]: [relation.scope ?? {}, link.targetWhere ?? {}] },
                bind: link.targetBind,
              },
              transaction,
            );
        }
        current();
        const primary = relation.sourceModel.primaryKeyAttribute;
        const readLinks = async (relation: ReturnType<typeof resolveManyToMany>) => {
          const rows = await relation.throughModel.unscoped().findAll(
            internalQuery({
              where: { [relation.foreignKey]: { [Op.in]: sourceKeys } },
              transaction,
              order: [[relation.foreignKey, 'ASC'] as [string, string], [relation.otherKey, 'ASC'] as [string, string]],
              lock: transaction.LOCK.UPDATE,
              limit: 10001,
            }),
          );
          current();
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
        let existingCount = 0;
        const plans: Array<{
          link: ManyToManyLinkSet;
          relation: ReturnType<typeof resolveManyToMany>;
          expected: Map<string, Set<string>>;
          changes: Map<string, { record: Model; key: string; add: string[]; remove: string[] }>;
        }> = [];
        for (const { index, link, relation, targetKeys } of ordered) {
          const before = await readLinks(relation);
          existingCount += [...before.values()].reduce((total, keys) => total + keys.size, 0);
          if (existingCount > 10000) invalid('Link mutation exceeds batch limit');
          const expected = new Map<string, Set<string>>();
          const changes: Array<{ record: Model; key: string; add: string[]; remove: string[] }> = [];
          for (const record of plan.records) {
            const key = normalizeKeys([record.getDataValue(primary)], relation.source)[0];
            const old = before.get(key)!;
            const desired = link.operation === 'set' ? new Set(targetKeys) : new Set(old);
            if (link.operation === 'add') for (const id of targetKeys) desired.add(id);
            if (link.operation === 'remove') for (const id of targetKeys) desired.delete(id);
            expected.set(key, desired);
            const add = [...desired].filter((id) => !old.has(id));
            const remove = [...old].filter((id) => !desired.has(id));
            if (add.length || remove.length) changes.push({ record, key, add, remove });
          }
          const additions = [...new Set(changes.flatMap((change) => change.add))];
          const changedTargets = [...new Set(changes.flatMap((change) => [...change.add, ...change.remove]))];
          if (entry?.authorizeChanges && changedTargets.length) {
            await entry.authorizeChanges(index, changedTargets, transaction);
            current();
          }
          if (entry && additions.length) {
            const scope = await entry.targetScope(index);
            current();
            await this.references.authorizeTargets(
              ctx,
              link.target,
              authenticated,
              {
                keys: additions,
                where: { [Op.and]: [relation.scope ?? {}, link.targetWhere ?? {}, scope.where ?? {}] },
                bind: link.targetBind,
              },
              transaction,
            );
            current();
          }
          plans.push({ link, relation, expected, changes: new Map(changes.map((change) => [change.key, change])) });
        }
        const protectedValues = snapshotProtectedValues(
          this.db,
          relation.source,
          plan.records,
          [
            ...references.map(({ relation }) => relation.foreignKey),
            ...(relation.sourceConfig.ownership.enabled ? ['tenantId'] : []),
          ],
          captureUserAuditFields(this.db, relation.source, authenticated),
        );
        const linkChanges = new Set(plans.flatMap((plan) => [...plan.changes.keys()]));
        const patches = new Map<string, Record<string, unknown>>();
        for (const record of plan.records) {
          const key = normalizeKeys([record.getDataValue(primary)], relation.source)[0];
          const values = plan.valuesFor(record);
          const scalarValues = Object.fromEntries(
            Object.entries(values).filter(
              ([field]) => !(relation.sourceConfig.ownership.enabled && field === 'tenantId'),
            ),
          );
          const scalarChanged = hasPersistedChanges(record, scalarValues);
          const patch: Record<string, unknown> = scalarChanged ? scalarValues : {};
          if (relation.sourceConfig.ownership.enabled && record.getDataValue('tenantId') == null)
            patch.tenantId = values.tenantId;
          if (referenceChanges.has(key))
            for (const { relation, targetKey } of references) patch[relation.foreignKey] = targetKey;
          if (linkChanges.has(key) || scalarChanged || referenceChanges.has(key)) patches.set(key, patch);
        }
        const changed = new Set(patches.keys());
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
        for (const record of plan.records) {
          const key = normalizeKeys([record.getDataValue(primary)], relation.source)[0];
          if (!patches.has(key)) continue;
          current();
          const patch = patches.get(key)!;
          // An explicit lifecycle stage also needs a source event for link-only changes.
          if (Object.keys(patch).length || afterPersist)
            await relation.source.repository.update({
              filterByTk: record.getDataValue(primary),
              values: patch,
              transaction,
              ...(entry ? { context: ctx } : {}),
              ...(request.individualHooks === undefined ? {} : { individualHooks: request.individualHooks }),
            });
          current();
          for (const { link, relation, changes } of plans) {
            const change = changes.get(key);
            if (!change) continue;
            const repository = relation.source.repository
              .relation<BelongsToManyRepository>(link.association)
              .of(record.getDataValue(primary));
            for (const operation of ['remove', 'add'] as const) {
              const targetKeys = change[operation];
              if (!targetKeys.length) continue;
              const joinCurrent = () => {
                current();
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
              joinCurrent();
              await guardJoinWrite(
                this.db,
                relation.source,
                relation.target,
                relation.through,
                relation.foreignKey,
                relation.otherKey,
                transaction,
                { operation, sourceKey: key, targetKeys },
                joinCurrent,
                () => repository[operation]({ tk: targetKeys, transaction, ...(entry ? { context: ctx } : {}) }),
              );
            }
          }
          current();
        }
        await afterPersist?.call(entry);
        await validateWriteTransaction(this.db, transaction, true);
        current();
        for (const { relation, expected } of plans) {
          const actual = await readLinks(relation);
          for (const key of sourceKeys)
            if (!isDeepStrictEqual(actual.get(key), expected.get(key)))
              invalid('Writer changed unauthorized connections');
        }
        const after = await relation.sourceModel.unscoped().findAll(
          internalQuery({
            where: { [primary]: { [Op.in]: sourceKeys } },
            transaction,
          }),
        );
        current();
        if (after.length !== sourceKeys.length) invalid('Writer removed a relation source');
        protectedValues.verify(after);
        for (const record of after)
          for (const { relation, targetKey } of references) {
            const actual = record.getDataValue(relation.foreignKey);
            if ((actual == null ? null : normalizeKeys([actual], relation.target)[0]) !== targetKey)
              invalid('Writer did not set the authorized foreign key');
          }
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
          keys: plan.records
            .filter((record) => patches.has(normalizeKeys([record.getDataValue(primary)], relation.source)[0]))
            .map((record) => record.getDataValue(primary) as string | number),
          affected: patches.size,
        };
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
