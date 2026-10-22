import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Op, Transaction, type Database, type Model, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import { resolveActiveAccessTenant, type AccessIdentity } from './context';
import { prepareCreationLinks, type AccessCreationLink } from './creation-links';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import { AccessReferenceService } from './references';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  plain,
  requiresSerializable,
  rootWriteBlockedFields,
  unavailable,
  validateRootValues,
  validateWriteTransaction,
} from './write-support';

export const MAX_CREATION_REFERENCES = 20;

const creationReceipts = new AsyncLocalStorage<object>();

export interface AccessCreationReference {
  association: string;
  target: AccessCollectionIdentity;
  key: string | number | null;
  where?: WhereOptions;
}

export interface AccessCreationRequest {
  /** Already filtered by the entry's action and field permissions. Root fields only. */
  values: Array<Record<string, unknown>>;
  /** Server-parsed role conditions; never a replacement for create action permission. */
  where?: WhereOptions;
  bind?: Record<string, unknown>;
  /** Trusted entry's independently finalized target grant; never accepted from client values. */
  reference?: AccessCreationReference;
  /** Multiple references are validated and persisted atomically with the single new record. */
  references?: AccessCreationReference[];
  /** Trusted, independently authorized selections of existing targets through pure join tables. */
  links?: AccessCreationLink[];
}

export interface AccessCreationPlan {
  readonly values: readonly Record<string, unknown>[];
  readonly transaction: Transaction;
}

/** Internal root creation adapter. Not registered on existing repositories; notifications must use afterCommit. */
export class AccessCreationService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async withCreatedRecords(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessCreationRequest,
    writer: (plan: AccessCreationPlan) => Promise<readonly Model[]>,
    assertEntryCurrent?: () => void,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    return this.create(ctx, identity, authenticated, request, writer, assertEntryCurrent);
  }

  /** The caller owns commit/rollback and must roll back the entire transaction after any error. */
  async withCreatedRecordsInTransaction(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessCreationRequest,
    transaction: Transaction,
    writer: (plan: AccessCreationPlan) => Promise<readonly Model[]>,
    assertEntryCurrent?: () => void,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    if (!(transaction instanceof Transaction)) invalid('An active root write transaction is required');
    return this.create(ctx, identity, authenticated, request, writer, assertEntryCurrent, transaction);
  }

  private async create(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessCreationRequest,
    writer: (plan: AccessCreationPlan) => Promise<readonly Model[]>,
    assertEntryCurrent?: () => void,
    inheritedTransaction?: Transaction,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    identity = { ...identity };
    authenticated = { ...authenticated };
    const original = request;
    request = cloneDeep(request);
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Collection has not migrated to access control');
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || collection.db !== this.db) invalid('Creation collection identity is unavailable');
    const model = collection.model;
    const primary = model.primaryKeyAttribute;
    if (request.reference !== undefined && request.references !== undefined)
      invalid('Supply either a single reference or a reference list');
    const references =
      request.references === undefined
        ? request.reference === undefined
          ? []
          : [request.reference]
        : request.references;
    if (
      !Array.isArray(references) ||
      Object.getPrototypeOf(references) !== Array.prototype ||
      references.length > MAX_CREATION_REFERENCES ||
      Reflect.ownKeys(references).length !== references.length + 1 ||
      Array.from({ length: references.length }, (_, index) => index).some((index) => !Object.hasOwn(references, index))
    )
      invalid('Creation references require a bounded dense list');
    const names = new Set<string>();
    const plans = references.map((reference) => {
      if (!plain(reference) || typeof reference.association !== 'string' || names.has(reference.association))
        invalid('Creation references must have distinct registered association names');
      names.add(reference.association);
      const relation = resolveBelongsTo(
        this.db,
        this.prepared,
        this.queries,
        ctx,
        identity,
        reference.target,
        reference.association,
        true,
      );
      const key = reference.key === null ? null : normalizeKeys([reference.key], relation.target)[0];
      return { reference, relation, key };
    });
    const expectedReferences = new Map(plans.map((plan) => [plan.relation.foreignKey, plan]));
    const links = request.links === undefined ? [] : request.links;
    if (
      !Array.isArray(links) ||
      (request.links !== undefined && Object.getPrototypeOf(original.links) !== Array.prototype) ||
      links.length + plans.length > MAX_CREATION_REFERENCES ||
      Reflect.ownKeys(links).length !== links.length + 1 ||
      Array.from({ length: links.length }, (_, index) => index).some((index) => !Object.hasOwn(links, index))
    )
      invalid('Creation references and links require a bounded dense list');
    for (const link of links) {
      if (!plain(link) || typeof link.association !== 'string' || names.has(link.association))
        invalid('Creation references must have distinct registered association names');
      names.add(link.association);
    }
    const linkPlan = links.length
      ? prepareCreationLinks(this.db, this.prepared, this.queries, ctx, identity, links, original.links!)
      : undefined;
    const metadata =
      plans.length > 0 &&
      accessMetadataGuard(
        this.db,
        [
          { model, config },
          ...plans.map(({ relation }) => ({ model: relation.targetModel, config: relation.targetConfig })),
        ],
        plans.map(({ reference }) => ({ model, path: [reference.association] })),
      );
    const current = () => {
      for (const { relation } of plans) relation.current();
      if (metadata) metadata();
      linkPlan?.current();
      if (
        this.prepared.configuration(ctx, identity) !== config ||
        !this.queries.isCurrentCollection(identity, collection, model)
      )
        invalid('Creation collection identity or access phase changed');
      // SQLite applies the generated insert ID through a model setter before afterQuery.
      // Until the physical insert ID has its own adapter, that combination cannot prove provenance.
      if (this.db.sequelize.getDialect() === 'sqlite' && model.rawAttributes[primary]?.autoIncrement) {
        const setters = (model.prototype as Model & { _customSetters?: Record<string, unknown> })._customSetters;
        if (model.rawAttributes[primary].set || setters?.[primary] || model.options.setterMethods?.[primary])
          invalid('Generated SQLite primary keys with custom setters require their own adapter');
      }
      assertEntryCurrent?.();
    };
    current();
    if (!Array.isArray(request.values) || !request.values.length || request.values.length > 1000)
      invalid('Create between 1 and 1000 explicit records');
    if (model.primaryKeyAttributes.length !== 1) invalid('Creation requires a single primary key');
    const related = plans.length > 0 || links.length > 0;
    if (related && (request.values.length !== 1 || this.db.sequelize.getDialect() !== 'postgres'))
      throw new AccessMutationError(
        'UNSUPPORTED_ACCESS_MUTATION',
        'Reference creation requires one record and PostgreSQL',
        400,
      );
    for (const values of request.values)
      validateRootValues(this.db, values, collection, 'create', config.ownership.enabled);
    const blocked = [...rootWriteBlockedFields(this.db, collection, 'create')].filter(
      (field) =>
        (model.rawAttributes[field].type as { key?: string }).key !== 'VIRTUAL' &&
        !(config.ownership.enabled && field === 'tenantId'),
    );
    const serializable = related || requiresSerializable(config, request, collection);
    try {
      const execute = async (transaction: Transaction) => {
        const receiptScope = {};
        return creationReceipts.run(receiptScope, async () => {
          await validateWriteTransaction(this.db, transaction, serializable);
          const tenant = config.ownership.enabled
            ? await resolveActiveAccessTenant(this.db, authenticated, { transaction, lock: true })
            : undefined;
          const values = request.values.map((input) => {
            const row = cloneDeep(input);
            if (config.ownership.enabled) {
              if (row.tenantId != null && row.tenantId !== tenant)
                throw new AccessMutationError(
                  'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
                  'New records must belong to the current tenant',
                );
              row.tenantId = tenant;
            }
            for (const { reference, relation } of plans) row[relation.foreignKey] = reference.key;
            return row;
          });
          current();
          for (const { reference, relation, key } of plans) {
            if (key === null) continue;
            await new AccessReferenceService(this.db, this.prepared, this.queries).authorizeTargets(
              ctx,
              reference.target,
              authenticated,
              { keys: [key], where: { [Op.and]: [relation.scope ?? {}, reference.where ?? {}] } },
              transaction,
            );
            current();
          }
          if (linkPlan) {
            await linkPlan.authorize(authenticated, transaction);
            current();
          }
          const receipts = new Map<Model, string | number>();
          let unexpectedInserts = false;
          const hookName = `tenant-access-creation-${randomUUID()}`;
          // Capture the dialect's INSERT result before model afterCreate hooks can change dataValues.
          // Scope receipts to this call as concurrent/nested creations may share the transaction.
          // Remove the observer even when the writer throws.
          this.db.sequelize.addHook('afterQuery', hookName, (options, query) => {
            if (
              creationReceipts.getStore() !== receiptScope ||
              options.transaction !== transaction ||
              options.type !== 'INSERT'
            )
              return;
            const instance = (query as unknown as { instance?: Model }).instance;
            const queryModel = (options as typeof options & { model?: typeof model }).model;
            if (linkPlan && queryModel === model && !(instance instanceof model)) {
              unexpectedInserts = true;
              return;
            }
            if (!(instance instanceof model)) return;
            // afterQuery also runs on failed INSERTs: do not mask the original database error.
            if (receipts.has(instance) || receipts.size >= values.length) {
              unexpectedInserts = true;
              return;
            }
            receipts.set(instance, instance.getDataValue(primary) as string | number);
          });
          let records: readonly Model[];
          try {
            records = await writer(
              Object.freeze({
                get values() {
                  return cloneDeep(values);
                },
                transaction,
              }),
            );
            await validateWriteTransaction(this.db, transaction, serializable);
            current();
            if (
              !Array.isArray(records) ||
              records.length !== values.length ||
              records.some((record) => !(record instanceof model) || record.isNewRecord)
            )
              invalid('Creation writer must return all saved target models');
            if (
              unexpectedInserts ||
              receipts.size !== records.length ||
              records.some((record) => !receipts.has(record) || record.getDataValue(primary) !== receipts.get(record))
            )
              invalid('Creation results must match the actual INSERT receipts');
            const keys = records.map((record) => receipts.get(record)!);
            const normalized = normalizeKeys(keys, collection);
            if (normalized.length !== keys.length) invalid('Creation writer returned duplicate record keys');
            if (linkPlan) {
              await linkPlan.persist(normalized[0], transaction, current);
              await validateWriteTransaction(this.db, transaction, serializable);
              current();
            }
            const targetWhere = { [primary]: { [Op.in]: normalized } };
            // Verify raw persisted ownership; presentation getters and returned Model fields are not authoritative.
            const stored = await model.unscoped().findAll(
              internalQuery({
                where: targetWhere,
                transaction,
                attributes: [...new Set([primary, ...(config.ownership.enabled ? ['tenantId'] : []), ...blocked])],
              }),
            );
            current();
            if (stored.length !== keys.length) invalid('Creation writer did not persist all target records');
            if (
              stored.some((record) =>
                blocked.some((field) => {
                  const value = record.getDataValue(field);
                  const expected = expectedReferences.get(field);
                  return expected
                    ? expected.key === null
                      ? value != null
                      : value == null || normalizeKeys([value], expected.relation.target)[0] !== expected.key
                    : value != null;
                }),
              )
            )
              invalid('Persisted association values require their own write adapters');
            if (config.ownership.enabled && stored.some((record) => record.getDataValue('tenantId') !== tenant))
              throw new AccessMutationError('ACCESS_OWNERSHIP_CHANGE_FORBIDDEN', 'Writer changed record ownership');
            const scoped = await this.queries.scopeQuery(
              ctx,
              identity,
              authenticated,
              {
                where: request.where === undefined ? targetWhere : { [Op.and]: [targetWhere, request.where] },
                bind: request.bind,
                transaction,
              },
              'ownership',
            );
            if (!scoped || scoped.config !== config) invalid('Creation access phase changed');
            const allowed = await model.findAll(internalQuery({ ...scoped.query, attributes: [primary] }));
            current();
            if (allowed.length !== keys.length) unavailable();
            if (linkPlan) {
              await linkPlan.verify(normalized[0], transaction);
              current();
            }
            if (unexpectedInserts || receipts.size !== records.length)
              invalid('Creation results must match the actual INSERT receipts');
            return { keys, affected: keys.length };
          } finally {
            this.db.sequelize.removeHook('afterQuery', hookName);
          }
        });
      };
      if (inheritedTransaction !== undefined) return await execute(inheritedTransaction);
      return await this.db.sequelize.transaction(
        {
          type: Transaction.TYPES.IMMEDIATE,
          ...(serializable ? { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE } : {}),
        },
        execute,
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
