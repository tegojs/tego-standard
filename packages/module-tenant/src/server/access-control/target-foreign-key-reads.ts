import { Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import { cloneDeep, internalQuery, invalid, normalizeKeys, plain, unavailable } from './write-support';

export interface TargetForeignKeyReadRequest {
  association: string;
  sourceKey: string | number;
  targetKey?: string | number;
  /** Server-parsed ACL and request predicates; entry adapters also check action and field permissions. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  transaction?: Transaction;
}

/** Explicit HasMany/HasOne read plans; never installs a global association interceptor. */
export class AccessTargetForeignKeyReadService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async scopeTargets(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: TargetForeignKeyReadRequest,
  ): Promise<ScopedAccessQuery> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    const allowed = [
      'association',
      'sourceKey',
      'targetKey',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
      'transaction',
    ];
    if (
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
      )
    )
      invalid('Unsupported association read input');
    // Transactions are live database objects, not request data to deep-copy.
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    const associationType = this.db.getCollection(source.collectionName)?.model.associations[request.association]
      ?.associationType;
    if (associationType !== 'HasMany' && associationType !== 'HasOne')
      invalid('Only target foreign-key reads are supported');
    const relation = resolveTargetForeignKey(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      source,
      target,
      request.association,
      associationType,
      false,
    );
    const conditions: WhereOptions[] = [];
    if (request.sourceKey !== '_') {
      const sourceKey = normalizeKeys([request.sourceKey], relation.source)[0];
      const keyWhere = { [relation.sourceModel.primaryKeyAttribute]: sourceKey };
      const sourceScope = await this.queries.scopeQuery(ctx, source, authenticated, {
        where: request.sourceWhere === undefined ? keyWhere : { [Op.and]: [keyWhere, request.sourceWhere] },
        bind: request.sourceBind,
        transaction,
      });
      if (!sourceScope || sourceScope.config !== relation.sourceConfig) invalid('Source read phase changed');
      const record = await relation.sourceModel.findOne(
        internalQuery({ ...sourceScope.query, attributes: [relation.sourceModel.primaryKeyAttribute] }),
      );
      relation.current();
      if (!record) unavailable();
      conditions.push({ [relation.foreignKey]: sourceKey });
    }
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
    if (!scoped || scoped.config !== relation.targetConfig) invalid('Target read phase changed');
    return scoped;
  }
}
