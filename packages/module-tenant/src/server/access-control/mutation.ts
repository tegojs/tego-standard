import { Op, Transaction, type Collection, type Database, type Model, type WhereOptions } from '@tego/server';

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
  snapshotProtectedValues,
  unavailable,
  validateRootValues,
  validateWriteTransaction,
} from './write-support';

export interface ExistingAccessMutation {
  operation: 'update' | 'destroy';
  keys: Array<string | number>;
  /** Already sanitized by the entry's role/field permissions. No associations in this phase. */
  values?: Record<string, unknown>;
  /** Server-parsed intersection of role and request conditions; not a replacement for action permission. */
  where?: WhereOptions;
  bind?: Record<string, unknown>;
}

export interface ExistingAccessWritePlan {
  readonly records: readonly Model[];
  readonly transaction: Transaction;
  valuesFor(record: Model): Record<string, unknown>;
}

/** Internal root-write adapter. Construction does not register hooks or change existing repositories. */
export class AccessMutationService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  private configuration(ctx: object, identity: AccessCollectionIdentity) {
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Collection has not migrated to access control');
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || collection.db !== this.db) invalid('Mutation collection identity is unavailable');
    return { config, collection };
  }

  private validateValues(request: ExistingAccessMutation, collection: Collection, managedOwnership: boolean) {
    if (!['update', 'destroy'].includes(request.operation)) invalid('Unsupported existing mutation');
    if (request.operation === 'destroy') {
      if (request.values !== undefined) invalid('Deletion cannot supply update values');
      if (
        (this.db.referenceMap.getReferences(collection.name) ?? []).some(
          (reference) => !['NO ACTION', 'RESTRICT'].includes(reference.onDelete),
        )
      )
        throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Cascaded writes require their own adapters', 400);
      return;
    }
    validateRootValues(this.db, request.values, collection, 'update', managedOwnership);
  }

  async authorizeExisting(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ExistingAccessMutation,
    transaction: Transaction | undefined,
  ): Promise<ExistingAccessWritePlan> {
    return this.authorize(ctx, identity, authenticated, request, transaction, false);
  }

  /** Internal relation-source primitive: authorizes/locks roots and produces only the claim patch. */
  async authorizeReferenceSource(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: Pick<ExistingAccessMutation, 'keys' | 'where' | 'bind'>,
    transaction: Transaction,
  ): Promise<ExistingAccessWritePlan> {
    return this.authorize(
      ctx,
      identity,
      authenticated,
      {
        operation: 'update',
        keys: request.keys,
        where: request.where,
        bind: request.bind,
      },
      transaction,
      true,
    );
  }

  private async authorize(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ExistingAccessMutation,
    transaction: Transaction | undefined,
    referenceOnly: boolean,
  ): Promise<ExistingAccessWritePlan> {
    identity = { ...identity };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    const { config, collection } = this.configuration(ctx, identity);
    const model = collection.model;
    const current = () => {
      if (
        this.prepared.configuration(ctx, identity) !== config ||
        !this.queries.isCurrentCollection(identity, collection, model)
      )
        invalid('Mutation collection identity changed');
    };
    if (!referenceOnly) this.validateValues(request, collection, config.ownership.enabled);
    const keys = normalizeKeys(request.keys, collection);
    if (!transaction) invalid('An active root write transaction is required');
    await validateWriteTransaction(this.db, transaction, requiresSerializable(config, request, collection));
    const activeTenant =
      !config.ownership.enabled || authenticated.tenantId === undefined
        ? undefined
        : await resolveActiveAccessTenant(this.db, authenticated, { transaction, lock: true });
    current();
    const primary = model.primaryKeyAttribute;
    const targetWhere = { [primary]: { [Op.in]: keys } };
    // Internal selection is not returned on failure. Lock all selected roots before checking any G.
    const records = await model.unscoped().findAll(
      internalQuery({
        where: targetWhere,
        order: [[primary, 'ASC'] as [string, string]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
    );
    if (records.length !== keys.length) unavailable();
    const predicate = {
      where: request.where === undefined ? targetWhere : { [Op.and]: [targetWhere, request.where] },
      bind: request.bind,
      transaction,
    };
    const scoped = await this.queries.scopeQuery(ctx, identity, authenticated, predicate, 'ownership');
    if (!scoped || scoped.config !== config) invalid('Mutation access phase changed');
    const allowed = await model.findAll(internalQuery({ ...scoped.query, attributes: [primary] }));
    current();
    if (allowed.length !== records.length) {
      if (config.ownership.enabled && records.some((record) => record.getDataValue('tenantId') == null)) {
        const readable = await this.queries.scopeQuery(ctx, identity, authenticated, predicate, 'read');
        if (!readable) invalid('Mutation access phase changed');
        const visible = await model.findAll(
          internalQuery({
            ...readable.query,
            attributes: [primary, 'tenantId'],
          }),
        );
        if (visible.length === records.length && visible.some((record) => record.getDataValue('tenantId') == null))
          throw new AccessMutationError('LEGACY_DATA_READ_ONLY', 'Legacy record is visible but cannot be edited');
      }
      unavailable();
    }
    const values = new Map<Model, Record<string, unknown>>();
    for (const record of records) {
      const patch = cloneDeep(request.values ?? {});
      if (config.ownership.enabled) {
        const storedTenant = record.getDataValue('tenantId');
        if (storedTenant == null && request.operation === 'destroy')
          throw new AccessMutationError('LEGACY_DATA_READ_ONLY', 'Unassigned legacy records cannot be deleted');
        const expectedTenant =
          storedTenant ??
          activeTenant ??
          (await resolveActiveAccessTenant(this.db, authenticated, { transaction, lock: true }));
        // Full edit forms commonly submit null for legacy data. The server owns the actual claim.
        if (
          Object.hasOwn(patch, 'tenantId') &&
          patch.tenantId !== expectedTenant &&
          !(storedTenant == null && patch.tenantId == null)
        )
          throw new AccessMutationError(
            'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
            'Ordinary edits cannot transfer ownership',
          );
        if (storedTenant == null) patch.tenantId = expectedTenant;
        else delete patch.tenantId;
      }
      values.set(record, patch);
    }
    current();
    return Object.freeze({
      records: Object.freeze(records),
      transaction,
      valuesFor(record: Model) {
        if (!values.has(record)) invalid('Record is not part of this write plan');
        return cloneDeep(values.get(record)!);
      },
    });
  }

  async withExistingRecords(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ExistingAccessMutation,
    writer: (plan: ExistingAccessWritePlan) => Promise<unknown>,
    assertEntryCurrent?: () => void,
  ): Promise<{ keys: Array<string | number>; affected: number }> {
    identity = { ...identity };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    const { config, collection } = this.configuration(ctx, identity);
    const model = collection.model;
    const serializable = requiresSerializable(config, request, collection);
    try {
      return await this.db.sequelize.transaction(
        {
          type: Transaction.TYPES.IMMEDIATE,
          ...(serializable ? { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE } : {}),
        },
        async (transaction) => {
          assertEntryCurrent?.();
          const plan = await this.authorizeExisting(ctx, identity, authenticated, request, transaction);
          assertEntryCurrent?.();
          const primary = model.primaryKeyAttribute;
          const keys = plan.records.map((record) => record.getDataValue(primary) as string | number);
          const expected = plan.records.map(
            (record) => plan.valuesFor(record).tenantId ?? record.getDataValue('tenantId'),
          );
          const protectedValues =
            request.operation === 'update'
              ? snapshotProtectedValues(this.db, collection, plan.records, config.ownership.enabled ? ['tenantId'] : [])
              : undefined;
          await writer(plan);
          await validateWriteTransaction(this.db, transaction, serializable);
          if (
            this.prepared.configuration(ctx, identity) !== config ||
            !this.queries.isCurrentCollection(identity, collection, model)
          )
            invalid('Mutation access phase changed during write');
          const after = await model.unscoped().findAll(
            internalQuery({
              where: { [primary]: { [Op.in]: keys } },
              transaction,
              attributes: [
                ...new Set([
                  primary,
                  ...(config.ownership.enabled ? ['tenantId'] : []),
                  ...(protectedValues?.fields ?? []),
                ]),
              ],
            }),
          );
          if (
            this.prepared.configuration(ctx, identity) !== config ||
            !this.queries.isCurrentCollection(identity, collection, model)
          )
            invalid('Mutation collection identity changed');
          if (request.operation === 'destroy') {
            if (after.length) invalid('Writer did not delete all authorized targets');
          } else {
            if (after.length !== keys.length) invalid('Writer removed an update target');
            protectedValues!.verify(after);
            if (config.ownership.enabled) {
              const owners = new Map(keys.map((key, i) => [String(key), expected[i]]));
              if (
                after.some(
                  (record) => record.getDataValue('tenantId') !== owners.get(String(record.getDataValue(primary))),
                )
              )
                throw new AccessMutationError('ACCESS_OWNERSHIP_CHANGE_FORBIDDEN', 'Writer changed record ownership');
            }
          }
          assertEntryCurrent?.();
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
