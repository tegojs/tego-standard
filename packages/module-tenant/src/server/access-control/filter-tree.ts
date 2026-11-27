import { literal, Op, type Collection, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { resolveManyToManyRead } from './many-to-many-read-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import type { AccessConfig } from './types';
import { cloneDeep, invalid, plain } from './write-support';

export type AccessFilterNode =
  | { type: 'predicate'; where: WhereOptions; bind?: Record<string, unknown> }
  | { type: 'all' | 'any'; children: AccessFilterNode[] }
  | { type: 'not'; child: AccessFilterNode }
  | {
      type: 'association';
      association: string;
      exists: boolean;
      target: AccessCollectionIdentity;
      through?: AccessCollectionIdentity;
      targetWhere?: WhereOptions;
      targetBind?: Record<string, unknown>;
      throughWhere?: WhereOptions;
      throughBind?: Record<string, unknown>;
      condition?: AccessFilterNode;
    };

export interface AccessFilterTreeRequest {
  filter: AccessFilterNode;
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  reservedBindNames?: readonly string[];
  transaction?: Transaction;
}

export interface AccessFilterTreePlan extends ScopedAccessQuery {
  assertCurrent(): void;
}

interface CapturedCollection {
  identity: AccessCollectionIdentity;
  collection: Collection;
  model: Collection['model'];
  config: AccessConfig;
}

type FilterRelation =
  | ReturnType<typeof resolveBelongsTo>
  | ReturnType<typeof resolveTargetForeignKey>
  | ReturnType<typeof resolveManyToManyRead>;

/** Internal server-parsed filter trees, never client-supplied authorization plans. */
export class AccessFilterTreeService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async scopeRoots(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessFilterTreeRequest,
  ): Promise<AccessFilterTreePlan> {
    source = { ...source };
    authenticated = { ...authenticated };
    const shape = (input: unknown, keys: string[]) => {
      if (
        !plain(input) ||
        Reflect.ownKeys(input).some(
          (key) =>
            typeof key !== 'string' ||
            !keys.includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
        )
      )
        invalid('Unsupported filter tree input');
    };
    shape(request, ['filter', 'sourceWhere', 'sourceBind', 'reservedBindNames', 'transaction']);
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    const captured: CapturedCollection[] = [];
    const relations = new Map<
      AccessFilterNode,
      { relation: FilterRelation; target: CapturedCollection; through?: CapturedCollection }
    >();
    const capture = (identity: AccessCollectionIdentity): CapturedCollection => {
      shape(identity, ['dataSourceKey', 'collectionKey', 'collectionName']);
      const config = this.prepared.configuration(ctx, identity);
      const collection = this.db.getCollection(identity.collectionName);
      if (!config || !collection || !this.queries.isCurrentCollection(identity, collection))
        invalid('Filter collection requires a current prepared configuration');
      const found = captured.find((entry) => entry.collection === collection);
      if (found) {
        if (
          found.config !== config ||
          found.identity.dataSourceKey !== identity.dataSourceKey ||
          found.identity.collectionKey !== identity.collectionKey
        )
          invalid('Conflicting filter collection identities');
        return found;
      }
      const entry = { identity, collection, config, model: collection.model };
      captured.push(entry);
      return entry;
    };
    const root = capture(source);
    let bind: Record<string, unknown> = {};
    const reserveBindings = (values: Record<string, unknown> | undefined) => {
      if (values === undefined) return;
      if (!plain(values) || Reflect.ownKeys(values).some((key) => typeof key !== 'string' || Object.hasOwn(bind, key)))
        invalid('Filter SQL bindings must be named and distinct across the tree');
      bind = { ...bind, ...values };
    };
    reserveBindings(request.sourceBind);
    let nodes = 0;
    const visit = (node: AccessFilterNode, current: CapturedCollection, depth = 0): void => {
      if (++nodes > 100 || depth > 8 || !plain(node)) invalid('Filter tree exceeds size/depth limits or is malformed');
      switch (node.type) {
        case 'predicate':
          shape(node, ['type', 'where', 'bind']);
          if (node.where == null) invalid('Supply a server-parsed predicate');
          reserveBindings(node.bind);
          return;
        case 'all':
        case 'any':
          shape(node, ['type', 'children']);
          if (
            !Array.isArray(node.children) ||
            node.children.length > 100 ||
            Array.from({ length: node.children.length }, (_, i) => !Object.hasOwn(node.children, i)).some(Boolean) ||
            Reflect.ownKeys(node.children).length !== node.children.length + 1
          )
            invalid('Filter groups require bounded dense child arrays');
          node.children.forEach((child) => visit(child, current, depth + 1));
          return;
        case 'not':
          shape(node, ['type', 'child']);
          visit(node.child, current, depth + 1);
          return;
        case 'association': {
          shape(node, [
            'type',
            'association',
            'exists',
            'target',
            'through',
            'targetWhere',
            'targetBind',
            'throughWhere',
            'throughBind',
            'condition',
          ]);
          if (typeof node.association !== 'string' || !node.association || typeof node.exists !== 'boolean')
            invalid('Supply an explicit association and existence boolean');
          const kind = current.model.associations[node.association]?.associationType;
          if (
            kind !== 'BelongsToMany' &&
            ['through', 'throughWhere', 'throughBind'].some((key) => Object.hasOwn(node, key))
          )
            invalid('Through options require a many-to-many relation');
          const target = capture(node.target);
          const through = kind === 'BelongsToMany' ? capture(node.through!) : undefined;
          const relation =
            kind === 'BelongsTo'
              ? resolveBelongsTo(
                  this.db,
                  this.prepared,
                  this.queries,
                  ctx,
                  current.identity,
                  target.identity,
                  node.association,
                )
              : kind === 'HasMany' || kind === 'HasOne'
                ? resolveTargetForeignKey(
                    this.db,
                    this.prepared,
                    this.queries,
                    ctx,
                    current.identity,
                    target.identity,
                    node.association,
                    kind,
                    false,
                  )
                : kind === 'BelongsToMany'
                  ? resolveManyToManyRead(
                      this.db,
                      this.prepared,
                      this.queries,
                      ctx,
                      current.identity,
                      target.identity,
                      through!.identity,
                      node.association,
                    )
                  : invalid('Unsupported filter relation');
          if (relation.sourceModel === relation.targetModel || relation.sourceModel.name === relation.targetModel.name)
            invalid('Filter relations require distinct registered model aliases');
          relations.set(node, { relation, target, through });
          reserveBindings(node.targetBind);
          reserveBindings(node.throughBind);
          if (node.condition !== undefined) visit(node.condition, target, depth + 1);
          return;
        }
        default:
          invalid('Unknown filter node type');
      }
    };
    // Capture every branch before any await, including branches masked by a constant sibling.
    visit(request.filter, root);
    const metadataCurrent = accessMetadataGuard(
      this.db,
      captured.map(({ model, config }) => ({ model, config })),
    );
    const assertCurrent = () => {
      for (const entry of captured) {
        if (
          this.prepared.configuration(ctx, entry.identity) !== entry.config ||
          !this.queries.isCurrentCollection(entry.identity, entry.collection, entry.model)
        )
          invalid('Filter collection phase or identity changed');
      }
      for (const { relation } of relations.values()) relation.current();
      metadataCurrent();
    };
    assertCurrent();
    const qi = this.db.sequelize.getQueryInterface();
    const quote = (name: string) => qi.quoteIdentifier(name);
    const usedAliases = new Set(captured.map((entry) => entry.model.name.toLowerCase()));
    let aliasIndex = 0;
    const nextAlias = () => {
      let alias: string;
      do {
        alias = `tac_filter_${aliasIndex++}`;
      } while (usedAliases.has(alias.toLowerCase()));
      usedAliases.add(alias.toLowerCase());
      return alias;
    };
    const column = (model: Collection['model'], name: string) => {
      const attribute = model.rawAttributes[name];
      if (!attribute) invalid('Filter relation key is unavailable');
      return `${quote(model.name)}.${quote(attribute.field || name)}`;
    };
    const generator = qi.queryGenerator as unknown as {
      getWhereConditions(where: WhereOptions, alias: string, model: Collection['model']): string;
      selectQuery(
        table: ReturnType<Collection['model']['getTableName']>,
        options: object,
        model: Collection['model'],
      ): string;
    };
    const orm = this.db.sequelize.constructor as unknown as {
      Utils: { mapOptionFieldNames<T extends object>(options: T, model: Collection['model']): T };
    };
    const selectKeys = (model: Collection['model'], fields: Array<[string, string]>, where: WhereOptions) => {
      const options = orm.Utils.mapOptionFieldNames(
        {
          tableAs: model.name,
          attributes: fields.map(([field, alias]) => literal(`${column(model, field)} AS ${quote(alias)}`)),
          where,
        },
        model,
      );
      return generator.selectQuery(model.getTableName(), options, model).replace(/;\s*$/, '');
    };
    const scope = async (entry: CapturedCollection, where: WhereOptions) => {
      const result = await this.queries.scopeQuery(ctx, entry.identity, authenticated, {
        where,
        bind,
        transaction,
        reservedBindNames: request.reservedBindNames,
      });
      assertCurrent();
      if (!result || result.config !== entry.config) invalid('Filter scope phase changed');
      bind = result.query.bind!;
      return result;
    };
    const compile = async (node: AccessFilterNode, model: Collection['model']): Promise<WhereOptions> => {
      switch (node.type) {
        case 'predicate':
          return node.where;
        case 'all':
        case 'any': {
          const children: WhereOptions[] = [];
          for (const child of node.children) children.push(await compile(child, model));
          return children.length
            ? { [node.type === 'all' ? Op.and : Op.or]: children }
            : literal(node.type === 'all' ? 'TRUE' : 'FALSE');
        }
        case 'not': {
          const mapped = orm.Utils.mapOptionFieldNames({ where: await compile(node.child, model) }, model);
          // Sequelize ignores Op.not around a Literal; emit explicit SQL NOT after normal ORM mapping.
          const sql = generator.getWhereConditions(mapped.where, model.name, model);
          return literal(`NOT (${sql || 'TRUE'})`);
        }
        case 'association': {
          const { relation, target, through } = relations.get(node)!;
          const conditions: WhereOptions[] = [];
          if (relation.scope !== undefined) conditions.push(relation.scope);
          if (node.targetWhere !== undefined) conditions.push(node.targetWhere);
          if (node.condition !== undefined) conditions.push(await compile(node.condition, relation.targetModel));
          const targetScope = await scope(target, { [Op.and]: conditions });
          const belongsTo = relation.sourceModel.associations[node.association].associationType === 'BelongsTo';
          const targetKey = belongsTo || through ? relation.targetModel.primaryKeyAttribute : relation.foreignKey;
          const targetSql = selectKeys(relation.targetModel, [[targetKey, 'match_key']], targetScope.query.where!);
          const targetAlias = nextAlias();
          const targetColumn = `${quote(targetAlias)}.${quote('match_key')}`;
          const sourceField = belongsTo ? relation.foreignKey : relation.sourceModel.primaryKeyAttribute;
          const sourceColumn = column(relation.sourceModel, sourceField);
          let correlation = `${targetColumn} = ${sourceColumn}`;
          if ('throughModel' in relation) {
            const linkConditions: WhereOptions[] = [];
            if (relation.throughScope !== undefined) linkConditions.push(relation.throughScope);
            if (node.throughWhere !== undefined) linkConditions.push(node.throughWhere);
            const linkScope = await scope(through!, { [Op.and]: linkConditions });
            const linkSql = selectKeys(
              relation.throughModel,
              [
                [relation.foreignKey, 'source_key'],
                [relation.otherKey, 'target_key'],
              ],
              linkScope.query.where!,
            );
            const linkAlias = nextAlias();
            correlation =
              `EXISTS (SELECT 1 FROM (${linkSql}) AS ${quote(linkAlias)} WHERE ` +
              `${quote(linkAlias)}.${quote('source_key')} = ${sourceColumn} AND ${quote(linkAlias)}.${quote('target_key')} = ${targetColumn})`;
          }
          // Keep parsed predicates on registered model aliases, and correlate only outside the derived query.
          const exists = `EXISTS (SELECT 1 FROM (${targetSql}) AS ${quote(targetAlias)} WHERE ${correlation})`;
          return literal(node.exists ? exists : `NOT (${exists})`);
        }
      }
    };
    const where = await compile(request.filter, root.model);
    assertCurrent();
    const conditions: WhereOptions[] = [where];
    if (request.sourceWhere !== undefined) conditions.push(request.sourceWhere);
    const scoped = await scope(root, { [Op.and]: conditions });
    return { ...scoped, assertCurrent };
  }
}
