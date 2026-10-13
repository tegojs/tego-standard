import { Op, type Database, type Model, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  unavailable,
  validateWriteTransaction,
} from './write-support';

export interface AccessTargetSelection {
  keys: Array<string | number>;
  /** Server-parsed role/request predicates; callers must also check the action permission. */
  where?: WhereOptions;
  bind?: Record<string, unknown>;
}

export interface BelongsToReadRequest {
  association: string;
  sourceKey: string | number;
  targetKey?: string | number;
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  transaction?: Transaction;
}

/** Explicit association adapters only; no global eager-loading or ACL interception. */
export class AccessReferenceService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async authorizeTargets(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessTargetSelection,
    transaction?: Transaction,
  ): Promise<readonly Model[]> {
    identity = { ...identity };
    authenticated = { ...authenticated };
    request = cloneDeep(request);
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Reference target has not migrated to access control');
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection) invalid('Reference target is unavailable');
    const model = collection.model;
    const keys = normalizeKeys(request.keys, collection);
    if (transaction) await validateWriteTransaction(this.db, transaction, true);
    const targetWhere = { [model.primaryKeyAttribute]: { [Op.in]: keys } };
    const scoped = await this.queries.scopeQuery(ctx, identity, authenticated, {
      where: request.where === undefined ? targetWhere : { [Op.and]: [targetWhere, request.where] },
      bind: request.bind,
      transaction,
    });
    if (!scoped || scoped.config !== config) invalid('Reference target phase changed');
    const records = await model.findAll(
      internalQuery({
        ...scoped.query,
        order: [[model.primaryKeyAttribute, 'ASC'] as [string, string]],
        ...(transaction ? { lock: transaction.LOCK.SHARE } : {}),
      }),
    );
    if (
      this.prepared.configuration(ctx, identity) !== config ||
      !this.queries.isCurrentCollection(identity, collection, model)
    )
      invalid('Reference target identity changed');
    if (records.length !== keys.length) unavailable();
    return Object.freeze(records);
  }

  async scopeBelongsToTarget(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToReadRequest,
  ): Promise<ScopedAccessQuery> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    // Preserve a live transaction object; clone only the caller's predicates and scalar inputs.
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    const relation = resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, target, request.association);
    let key: unknown;
    if (request.sourceKey === '_') {
      if (request.targetKey === undefined) invalid('Direct association target reads require an explicit target key');
      key = normalizeKeys([request.targetKey], relation.target)[0];
    } else {
      const sourceKey = normalizeKeys([request.sourceKey], relation.source)[0];
      const keyWhere = { [relation.sourceModel.primaryKeyAttribute]: sourceKey };
      const scoped = await this.queries.scopeQuery(ctx, source, authenticated, {
        where: request.sourceWhere === undefined ? keyWhere : { [Op.and]: [keyWhere, request.sourceWhere] },
        bind: request.sourceBind,
        transaction,
      });
      if (!scoped) invalid('Source has not migrated to access control');
      const record = await relation.sourceModel.findOne(
        internalQuery({
          ...scoped.query,
          attributes: [relation.sourceModel.primaryKeyAttribute, relation.foreignKey],
        }),
      );
      relation.current();
      if (!record) unavailable();
      key = record.getDataValue(relation.foreignKey);
      if (key != null) key = normalizeKeys([key], relation.target)[0];
    }
    const conditions: WhereOptions[] = [
      { [relation.targetModel.primaryKeyAttribute]: { [Op.in]: key == null ? [] : [key] } },
    ];
    if (request.targetKey !== undefined)
      conditions.push({
        [relation.targetModel.primaryKeyAttribute]: normalizeKeys([request.targetKey], relation.target)[0],
      });
    if (relation.scope !== undefined) conditions.push(relation.scope);
    if (request.targetWhere !== undefined) conditions.push(request.targetWhere);
    const scoped = await this.queries.scopeQuery(ctx, target, authenticated, {
      where: { [Op.and]: conditions },
      bind: request.targetBind,
      transaction,
    });
    relation.current();
    if (!scoped) invalid('Target has not migrated to access control');
    return scoped;
  }
}
