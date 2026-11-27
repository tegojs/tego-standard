import { literal, Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { resolveManyToManyRead } from './many-to-many-read-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import type { AccessRootReadConstraint } from './reads';
import type { AccessConfig } from './types';
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

interface PreparedManyToManyRead {
  readonly target: AccessCollectionIdentity;
  readonly authenticated: AccessIdentity;
  readonly config: AccessConfig;
  readonly transaction: Transaction | undefined;
  assertCurrent(): void;
  resolve(): Promise<AccessRootReadConstraint>;
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
    const plan = this.prepareTargets(ctx, source, target, through, authenticated, request);
    const constraint = await plan.resolve();
    const scoped = await this.queries.scopeQuery(ctx, plan.target, plan.authenticated, {
      where: constraint.where,
      bind: constraint.bind,
      transaction: plan.transaction,
    });
    constraint.assertCurrent();
    if (!scoped || scoped.config !== plan.config) invalid('Target read phase changed');
    return scoped;
  }

  /** Capture all three relationship boundaries before resolving the source or selecting targets. */
  prepareTargets(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    through: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyReadRequest,
  ): PreparedManyToManyRead {
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
    const verifyMetadata = accessMetadataGuard(this.db, [
      { model: relation.sourceModel, config: relation.configs[0]! },
      { model: relation.targetModel, config: relation.configs[1]! },
      { model: relation.throughModel, config: relation.configs[2]! },
    ]);
    const current = () => {
      relation.current();
      verifyMetadata();
    };
    const sourceKey = request.sourceKey === '_' ? undefined : normalizeKeys([request.sourceKey], relation.source)[0];
    const targetKey =
      request.targetKey === undefined ? undefined : normalizeKeys([request.targetKey], relation.target)[0];
    return {
      target,
      authenticated,
      config: relation.configs[1]!,
      transaction,
      assertCurrent: current,
      resolve: async () => {
        current();
        const conditions: WhereOptions[] = [];
        let bind = { ...request.targetBind };
        if (sourceKey !== undefined) {
          const keyWhere = { [relation.sourceModel.primaryKeyAttribute]: sourceKey };
          const sourceScope = await this.queries.scopeQuery(ctx, source, authenticated, {
            where: request.sourceWhere === undefined ? keyWhere : { [Op.and]: [keyWhere, request.sourceWhere] },
            bind: request.sourceBind,
            transaction,
          });
          current();
          if (!sourceScope || sourceScope.config !== relation.configs[0]) invalid('Source read phase changed');
          const record = await relation.sourceModel.findOne(
            internalQuery({ ...sourceScope.query, attributes: [relation.sourceModel.primaryKeyAttribute] }),
          );
          current();
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
          current();
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
        if (targetKey !== undefined)
          conditions.push({
            [relation.targetModel.primaryKeyAttribute]: targetKey,
          });
        if (relation.scope !== undefined) conditions.push(relation.scope);
        if (request.targetWhere !== undefined) conditions.push(request.targetWhere);
        current();
        return { where: { [Op.and]: conditions }, bind, assertCurrent: current };
      },
    };
  }
}
