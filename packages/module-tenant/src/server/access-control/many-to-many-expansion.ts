import { literal, Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureExpansionRequest, normalizeExpansionKeys, type AccessExpansionRecord } from './expansion-page';
import { resolveManyToManyRead } from './many-to-many-read-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { internalQuery, invalid, normalizeKeys, plain, unavailable } from './write-support';

export interface ManyToManyExpansionRequest {
  association: string;
  sourceKeys: Array<string | number>;
  /** Physical target fields already approved by the entry adapter's field ACL. */
  targetAttributes: string[];
  /** Trusted server-parsed ACL/request predicates for each collection independently. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  throughWhere?: WhereOptions;
  throughBind?: Record<string, unknown>;
  transaction?: Transaction;
}

/** Internal bounded expansion; entry adapters provide source/target/through action and field ACL. */
export class AccessManyToManyExpansionService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly assertAuthorizationCurrent?: () => void,
  ) {}

  async load(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    through: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyExpansionRequest,
  ): Promise<ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>> {
    const records = await this.read(ctx, source, target, through, authenticated, request, false);
    return new Map([...records].map(([key, values]) => [key, Object.freeze(values.map((record) => record.values))]));
  }

  /** Internal nested-assembly page, with the same target/through authorization as load. */
  page(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    through: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyExpansionRequest,
  ) {
    return this.read(ctx, source, target, through, authenticated, request, true);
  }

  private async read(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    through: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: ManyToManyExpansionRequest,
    pairing: boolean,
  ): Promise<ReadonlyMap<string, readonly AccessExpansionRecord[]>> {
    source = { ...source };
    target = { ...target };
    through = { ...through };
    authenticated = { ...authenticated };
    const allowed = [
      'association',
      'sourceKeys',
      'targetAttributes',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
      'throughWhere',
      'throughBind',
      'transaction',
    ];
    request = captureExpansionRequest(request, allowed, pairing);
    const { transaction } = request;
    if (request.sourceKeys.includes('_')) invalid('Expansion requires actual source keys, not a protocol placeholder');
    for (const bind of [request.sourceBind, request.targetBind, request.throughBind])
      if (bind !== undefined && !plain(bind)) invalid('Association expansion requires named SQL bindings');
    if (Object.keys(request.throughBind ?? {}).some((key) => Object.hasOwn(request.targetBind ?? {}, key)))
      invalid('Through and target SQL bindings must have distinct names');
    if (typeof request.association !== 'string' || !request.association)
      invalid('Select a registered many-to-many association');
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
    const models = [relation.sourceModel, relation.targetModel, relation.throughModel];
    const verifyMetadata = accessMetadataGuard(
      this.db,
      models.map((model, index) => ({ model, config: relation.configs[index]! })),
    );
    const current = () => {
      this.assertAuthorizationCurrent?.();
      relation.current();
      verifyMetadata();
    };
    const keys = normalizeExpansionKeys(request.sourceKeys, relation.source);
    if (
      (!pairing && !request.targetAttributes.length) ||
      request.targetAttributes.some(
        (name) =>
          typeof name !== 'string' ||
          !Object.hasOwn(relation.targetModel.rawAttributes, name) ||
          (relation.targetModel.rawAttributes[name].type as { key?: string }).key === 'VIRTUAL',
      )
    )
      invalid('Select explicit physical target attributes');
    const attributes = [...new Set(request.targetAttributes)];
    const sourcePrimary = relation.sourceModel.primaryKeyAttribute;
    const targetPrimary = relation.targetModel.primaryKeyAttribute;
    const sourceWhere: WhereOptions[] = [{ [sourcePrimary]: { [Op.in]: keys } }];
    if (request.sourceWhere !== undefined) sourceWhere.push(request.sourceWhere);
    current();
    const sourceScope = await this.queries.scopeQuery(ctx, source, authenticated, {
      where: { [Op.and]: sourceWhere },
      bind: request.sourceBind,
      transaction,
    });
    current();
    if (!sourceScope || sourceScope.config !== relation.configs[0]) invalid('Source expansion phase changed');
    const sources = await relation.sourceModel.findAll(
      internalQuery({ ...sourceScope.query, attributes: [sourcePrimary] }),
    );
    current();
    if (sources.length !== keys.length) unavailable();
    const targetWhere: WhereOptions[] = [];
    if (relation.scope !== undefined) targetWhere.push(relation.scope);
    if (request.targetWhere !== undefined) targetWhere.push(request.targetWhere);
    const targetScope = await this.queries.scopeQuery(ctx, target, authenticated, {
      where: { [Op.and]: targetWhere },
      bind: { ...request.targetBind, ...request.throughBind },
      transaction,
    });
    current();
    if (!targetScope || targetScope.config !== relation.configs[1]) invalid('Target expansion phase changed');
    const throughWhere: WhereOptions[] = [{ [relation.foreignKey]: { [Op.in]: keys } }];
    if (relation.throughScope !== undefined) throughWhere.push(relation.throughScope);
    if (request.throughWhere !== undefined) throughWhere.push(request.throughWhere);
    const throughScope = await this.queries.scopeQuery(ctx, through, authenticated, {
      where: { [Op.and]: throughWhere },
      bind: targetScope.query.bind,
      transaction,
    });
    current();
    if (!throughScope || throughScope.config !== relation.configs[2]) invalid('Through expansion phase changed');

    const qi = this.db.sequelize.getQueryInterface();
    const quote = (name: string) => qi.quoteIdentifier(name);
    const generator = qi.queryGenerator as unknown as {
      selectQuery(
        table: ReturnType<typeof relation.targetModel.getTableName>,
        options: object,
        model: typeof relation.targetModel,
      ): string;
    };
    const orm = this.db.sequelize.constructor as unknown as {
      Utils: { mapOptionFieldNames<T extends object>(options: T, model: typeof relation.targetModel): T };
    };
    const select = (model: typeof relation.targetModel, options: object) =>
      generator
        .selectQuery(model.getTableName(), orm.Utils.mapOptionFieldNames(options, model), model)
        .replace(/;\s*$/, '');
    const targetSql = select(relation.targetModel, {
      tableAs: relation.targetModel.name,
      where: targetScope.query.where,
      attributes: [...new Set([targetPrimary, ...attributes])],
    });
    const linkColumn = (name: string) =>
      `${quote(relation.throughModel.name)}.${quote(relation.throughModel.rawAttributes[name].field || name)}`;
    // Deduplicate only the pair of keys, so JSON or other selected target values need no SQL equality operator.
    const linkSql = select(relation.throughModel, {
      tableAs: relation.throughModel.name,
      where: throughScope.query.where,
      attributes: [
        [literal(`DISTINCT ${linkColumn(relation.foreignKey)}`), 'tac_source_key'],
        [literal(linkColumn(relation.otherKey)), 'tac_target_key'],
      ],
    });
    const occupied = new Set(
      Object.entries(relation.targetModel.rawAttributes).flatMap(([name, attr]) => [
        name.toLowerCase(),
        (attr.field || name).toLowerCase(),
      ]),
    );
    let sourceAlias = 'tac_expansion_source';
    while (occupied.has(sourceAlias.toLowerCase())) sourceAlias += '_';
    const to = quote('tac_expansion_target');
    const link = quote('tac_expansion_link');
    const sourceColumn = `${link}.${quote('tac_source_key')}`;
    const targetColumn = `${to}.${quote(targetPrimary)}`;
    const sql = `SELECT ${to}.*, ${sourceColumn} AS ${quote(sourceAlias)} FROM (${targetSql}) AS ${to} INNER JOIN (${linkSql}) AS ${link} ON ${targetColumn} = ${link}.${quote('tac_target_key')} ORDER BY ${sourceColumn} ASC, ${targetColumn} ASC LIMIT 10001`;
    // Decode normal model types without invoking repository hooks, getters, or association eager loading.
    const records = await this.db.sequelize.query(
      sql,
      internalQuery({
        model: relation.targetModel,
        bind: throughScope.query.bind,
        transaction,
      }),
    );
    current();
    if (records.length > 10000) invalid('Too many source-target pairs for a single expansion page');
    const grouped = new Map<string, AccessExpansionRecord[]>();
    for (const record of records) {
      const key = normalizeKeys([record.getDataValue(sourceAlias)], relation.source)[0];
      // Fresh query values preserve authorized JSON without applying mutation input limits.
      const values = Object.freeze(Object.fromEntries(attributes.map((name) => [name, record.getDataValue(name)])));
      const list = grouped.get(key) ?? [];
      list.push(
        Object.freeze({ key: normalizeKeys([record.getDataValue(targetPrimary)], relation.target)[0], values }),
      );
      grouped.set(key, list);
    }
    return new Map(keys.map((key) => [key, Object.freeze(grouped.get(key) ?? [])] as const));
  }
}
