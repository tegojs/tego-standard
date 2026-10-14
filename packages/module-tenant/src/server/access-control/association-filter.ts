import { literal, Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { resolveManyToManyRead } from './many-to-many-read-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import { cloneDeep, invalid, plain } from './write-support';

export interface AssociationFilterRequest {
  association: string;
  exists: boolean;
  through?: AccessCollectionIdentity;
  /** Trusted server-parsed predicates; entry adapters must authorize actions and filter fields. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  throughWhere?: WhereOptions;
  throughBind?: Record<string, unknown>;
  transaction?: Transaction;
}

export interface AssociationFilterPlan extends ScopedAccessQuery {
  /** Call before execution and after each database await, before exposing any result. */
  assertCurrent(): void;
}

/** Single-hop existence plans only; no global ORM/ACL interception or business activation. */
export class AccessAssociationFilterService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async scopeRoots(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AssociationFilterRequest,
  ): Promise<AssociationFilterPlan> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    const allowed = [
      'association',
      'exists',
      'through',
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
      invalid('Unsupported association filter input');
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    if (typeof request.exists !== 'boolean' || typeof request.association !== 'string' || !request.association)
      invalid('Supply an explicit association name and existence boolean');
    let bind: Record<string, unknown> = {};
    for (const values of [request.sourceBind, request.targetBind, request.throughBind]) {
      if (values === undefined) continue;
      if (!plain(values) || Reflect.ownKeys(values).some((key) => typeof key !== 'string' || Object.hasOwn(bind, key)))
        invalid('Filter SQL bindings must be named and distinct across all collections');
      bind = { ...bind, ...values };
    }
    const kind = this.db.getCollection(source.collectionName)?.model.associations[request.association]?.associationType;
    if (
      kind !== 'BelongsToMany' &&
      ['through', 'throughWhere', 'throughBind'].some((key) => Object.hasOwn(request, key))
    )
      invalid('Through options require a many-to-many association');
    if (kind === 'BelongsToMany' && !plain(request.through)) invalid('Many-to-many filters require a through identity');
    const relation =
      kind === 'BelongsTo'
        ? resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, target, request.association)
        : kind === 'HasMany' || kind === 'HasOne'
          ? resolveTargetForeignKey(
              this.db,
              this.prepared,
              this.queries,
              ctx,
              source,
              target,
              request.association,
              kind,
              false,
            )
          : kind === 'BelongsToMany'
            ? resolveManyToManyRead(
                this.db,
                this.prepared,
                this.queries,
                ctx,
                source,
                target,
                request.through!,
                request.association,
              )
            : invalid('Unsupported association filter relation');
    const { sourceModel, targetModel } = relation;
    if (sourceModel === targetModel || sourceModel.name === targetModel.name)
      invalid('Association filters require distinct registered model aliases');
    const identities = [source, target, ...(request.through ? [request.through] : [])];
    const collections = identities.map((identity) => this.db.getCollection(identity.collectionName));
    const configs = identities.map((identity) => this.prepared.configuration(ctx, identity)!);
    const metadataCurrent = accessMetadataGuard(
      this.db,
      collections.map((collection, index) => ({ model: collection.model, config: configs[index] })),
    );
    const assertCurrent = () => {
      relation.current();
      metadataCurrent();
    };
    assertCurrent();
    const qi = this.db.sequelize.getQueryInterface();
    const quote = (name: string) => qi.quoteIdentifier(name);
    const column = (model: typeof sourceModel, field: string) => {
      const attribute = model.rawAttributes[field];
      if (!attribute) invalid('Association filter key is unavailable');
      return `${quote(model.name)}.${quote(attribute.field || field)}`;
    };
    const generator = qi.queryGenerator as unknown as {
      selectQuery(
        table: ReturnType<typeof sourceModel.getTableName>,
        options: object,
        model: typeof sourceModel,
      ): string;
    };
    const orm = this.db.sequelize.constructor as unknown as {
      Utils: { mapOptionFieldNames<T extends object>(options: T, model: typeof sourceModel): T };
    };
    const existsSql = (model: typeof sourceModel, where: WhereOptions) => {
      const options = orm.Utils.mapOptionFieldNames({ attributes: [literal('1')], tableAs: model.name, where }, model);
      return `EXISTS (${generator.selectQuery(model.getTableName(), options, model).replace(/;\s*$/, '')})`;
    };
    const targetConditions: WhereOptions[] = [];
    if (relation.scope !== undefined) targetConditions.push(relation.scope);
    if (request.targetWhere !== undefined) targetConditions.push(request.targetWhere);
    if ('throughModel' in relation) {
      const throughModel = relation.throughModel;
      const throughConditions: WhereOptions[] = [
        literal(
          `${column(throughModel, relation.foreignKey)} = ${column(sourceModel, sourceModel.primaryKeyAttribute)} AND ` +
            `${column(throughModel, relation.otherKey)} = ${column(targetModel, targetModel.primaryKeyAttribute)}`,
        ),
      ];
      if (relation.throughScope !== undefined) throughConditions.push(relation.throughScope);
      if (request.throughWhere !== undefined) throughConditions.push(request.throughWhere);
      const scoped = await this.queries.scopeQuery(ctx, request.through!, authenticated, {
        where: { [Op.and]: throughConditions },
        bind,
        transaction,
      });
      assertCurrent();
      if (!scoped || scoped.config !== configs[2]) invalid('Through filter phase changed');
      targetConditions.push(literal(existsSql(throughModel, scoped.query.where!)));
      bind = scoped.query.bind!;
    } else {
      const sourceField = kind === 'BelongsTo' ? relation.foreignKey : sourceModel.primaryKeyAttribute;
      const targetField = kind === 'BelongsTo' ? targetModel.primaryKeyAttribute : relation.foreignKey;
      targetConditions.push(literal(`${column(targetModel, targetField)} = ${column(sourceModel, sourceField)}`));
    }
    const targetScope = await this.queries.scopeQuery(ctx, target, authenticated, {
      where: { [Op.and]: targetConditions },
      bind,
      transaction,
    });
    assertCurrent();
    if (!targetScope || targetScope.config !== configs[1]) invalid('Target filter phase changed');
    const existence = existsSql(targetModel, targetScope.query.where!);
    const conditions: WhereOptions[] = [literal(request.exists ? existence : `NOT (${existence})`)];
    if (request.sourceWhere !== undefined) conditions.push(request.sourceWhere);
    const scoped = await this.queries.scopeQuery(ctx, source, authenticated, {
      where: { [Op.and]: conditions },
      bind: targetScope.query.bind,
      transaction,
    });
    assertCurrent();
    if (!scoped || scoped.config !== configs[0]) invalid('Source filter phase changed');
    return { ...scoped, assertCurrent };
  }
}
