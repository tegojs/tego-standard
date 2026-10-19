import { randomUUID } from 'node:crypto';
import { Op, Transaction, type Database, type Model, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import { resolveActiveAccessTenant, type AccessIdentity } from './context';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  requiresSerializable,
  rootWriteBlockedFields,
  unavailable,
  validateRootValues,
  validateWriteTransaction,
} from './write-support';

export interface AccessCreationRequest {
  /** Already filtered by the entry's action and field permissions. Root fields only. */
  values: Array<Record<string, unknown>>;
  /** Server-parsed role conditions; never a replacement for create action permission. */
  where?: WhereOptions;
  bind?: Record<string, unknown>;
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
    identity = { ...identity };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Collection has not migrated to access control');
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || collection.db !== this.db) invalid('Creation collection identity is unavailable');
    const model = collection.model;
    const primary = model.primaryKeyAttribute;
    const current = () => {
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
    for (const values of request.values)
      validateRootValues(this.db, values, collection, 'create', config.ownership.enabled);
    const blocked = [...rootWriteBlockedFields(this.db, collection, 'create')].filter(
      (field) =>
        (model.rawAttributes[field].type as { key?: string }).key !== 'VIRTUAL' &&
        !(config.ownership.enabled && field === 'tenantId'),
    );
    const serializable = requiresSerializable(config, request, collection);
    try {
      return await this.db.sequelize.transaction(
        {
          type: Transaction.TYPES.IMMEDIATE,
          ...(serializable ? { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE } : {}),
        },
        async (transaction) => {
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
            return row;
          });
          current();
          const receipts = new Map<Model, string | number>();
          let unexpectedInserts = false;
          const hookName = `tenant-access-creation-${randomUUID()}`;
          // Capture the dialect's INSERT result before model afterCreate hooks can change dataValues.
          // This observer is confined to this transaction and is removed even when the writer throws.
          this.db.sequelize.addHook('afterQuery', hookName, (options, query) => {
            if (options.transaction !== transaction || options.type !== 'INSERT') return;
            const instance = (query as unknown as { instance?: Model }).instance;
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
          } finally {
            this.db.sequelize.removeHook('afterQuery', hookName);
          }
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
          if (stored.some((record) => blocked.some((field) => record.getDataValue(field) != null)))
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
