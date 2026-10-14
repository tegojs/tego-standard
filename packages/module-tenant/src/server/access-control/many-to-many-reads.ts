import { literal, Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { resolveManyToManyRead } from './many-to-many-read-metadata';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import { cloneDeep, internalQuery, invalid, normalizeKeys, plain, unavailable } from './write-support';

export interface ManyToManyReadRequest {
  association: string;
  sourceKey: string | number;
  targetKey?: string | number;
  /** Trusted server-parsed ACL/request predicates; entry adapters check action and field permissions. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  throughWhere?: WhereOptions;
  throughBind?: Record<string, unknown>;
  transaction?: Transaction;
}

/** Opt-in target query plans; EXISTS keeps root target pagination and aggregates independent of link count. */
export class AccessManyToManyReadService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async scopeTargets(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    through: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyReadRequest,
  ): Promise<ScopedAccessQuery> {
    source = { ...source };
    target = { ...target };
    through = { ...through };
    authenticated = { ...authenticated };
    const allowed = [
      'association',
      'sourceKey',
      'targetKey',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
      'throughWhere',
      'throughBind',
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
      invalid('Unsupported many-to-many read input');
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    for (const bind of [request.sourceBind, request.targetBind, request.throughBind])
      if (bind !== undefined && !plain(bind)) invalid('Association reads require named SQL bindings');
    if (Object.keys(request.throughBind ?? {}).some((key) => Object.hasOwn(request.targetBind ?? {}, key)))
      invalid('Through and target SQL bindings must have distinct names');
    const relation = resolveManyToManyRead(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      source,
      target,
      through,
      request.association,
    );
    const conditions: WhereOptions[] = [];
    let bind = { ...request.targetBind };
    if (request.sourceKey !== '_') {
      const sourceKey = normalizeKeys([request.sourceKey], relation.source)[0];
      const keyWhere = { [relation.sourceModel.primaryKeyAttribute]: sourceKey };
      const sourceScope = await this.queries.scopeQuery(ctx, source, authenticated, {
        where: request.sourceWhere === undefined ? keyWhere : { [Op.and]: [keyWhere, request.sourceWhere] },
        bind: request.sourceBind,
        transaction,
      });
      relation.current();
      if (!sourceScope || sourceScope.config !== relation.configs[0]) invalid('Source read phase changed');
      const record = await relation.sourceModel.findOne(
        internalQuery({ ...sourceScope.query, attributes: [relation.sourceModel.primaryKeyAttribute] }),
      );
      relation.current();
      if (!record) unavailable();
      // Keep the registered alias used by parsed ACL expressions; distinct model names cannot shadow the target.
      const alias = relation.throughModel.name;
      const linkWhere: WhereOptions[] = [{ [relation.foreignKey]: sourceKey }];
      if (relation.throughScope !== undefined) linkWhere.push(relation.throughScope);
      if (request.throughWhere !== undefined) linkWhere.push(request.throughWhere);
      const throughScope = await this.queries.scopeQuery(ctx, through, authenticated, {
        where: { [Op.and]: linkWhere },
        bind: { ...bind, ...request.throughBind },
        rootAlias: alias,
        transaction,
      });
      relation.current();
      if (!throughScope || throughScope.config !== relation.configs[2]) invalid('Through read phase changed');
      const qi = this.db.sequelize.getQueryInterface();
      const quote = (name: string) => qi.quoteIdentifier(name);
      const targetColumn =
        relation.targetModel.rawAttributes[relation.targetModel.primaryKeyAttribute].field ||
        relation.targetModel.primaryKeyAttribute;
      const otherColumn = relation.throughModel.rawAttributes[relation.otherKey].field || relation.otherKey;
      const correlation = literal(
        `${quote(alias)}.${quote(otherColumn)} = ${quote(relation.targetModel.name)}.${quote(targetColumn)}`,
      );
      // Scope compilation already includes the through model's effective default scope and paranoid boundary.
      const generator = qi.queryGenerator as unknown as {
        selectQuery(
          table: ReturnType<typeof relation.throughModel.getTableName>,
          options: object,
          model: typeof relation.throughModel,
        ): string;
      };
      // Match Sequelize findAll's attribute-to-column mapping before calling its lower-level generator.
      const orm = this.db.sequelize.constructor as unknown as {
        Utils: { mapOptionFieldNames<T extends object>(options: T, model: typeof relation.throughModel): T };
      };
      const options = orm.Utils.mapOptionFieldNames(
        {
          attributes: [literal('1')],
          tableAs: alias,
          where: { [Op.and]: [throughScope.query.where!, correlation] },
        },
        relation.throughModel,
      );
      const sql = generator.selectQuery(relation.throughModel.getTableName(), options, relation.throughModel);
      conditions.push(literal(`EXISTS (${sql.replace(/;\s*$/, '')})`));
      bind = throughScope.query.bind!;
    }
    if (request.targetKey !== undefined)
      conditions.push({
        [relation.targetModel.primaryKeyAttribute]: normalizeKeys([request.targetKey], relation.target)[0],
      });
    if (relation.scope !== undefined) conditions.push(relation.scope);
    if (request.targetWhere !== undefined) conditions.push(request.targetWhere);
    const scoped = await this.queries.scopeQuery(ctx, target, authenticated, {
      where: { [Op.and]: conditions },
      bind,
      transaction,
    });
    relation.current();
    if (!scoped || scoped.config !== relation.configs[1]) invalid('Target read phase changed');
    return scoped;
  }
}
