import {
  DataTypes,
  literal,
  Op,
  type Collection,
  type Database,
  type Model,
  type Transaction,
  type WhereOptions,
} from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { aggregateGroupExpression, captureAggregateGroups } from './aggregate-groups';
import { captureAggregateMeasures, type AccessAggregateMeasure, type AggregateMethod } from './aggregate-measures';
import { captureAggregateOrder } from './aggregate-order';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessFilterTreeService } from './filter-tree';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { captureReadKey } from './read-key';
import {
  AccessRequestFilterParser,
  type AccessFilterGrantResolver,
  type AccessFilterReadGrant,
} from './request-filter';
import { AccessSortService } from './sort';
import { cloneDeep, internalQuery, invalid, normalizeKeys, plain } from './write-support';

export interface AccessReadRequest {
  filter?: unknown;
  transaction?: Transaction;
}

export interface AccessListRequest extends AccessReadRequest {
  attributes: unknown;
  sort?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface AccessGetRequest extends AccessReadRequest {
  key: unknown;
  keyField?: unknown;
  attributes: unknown;
}

export interface AccessSumRequest extends AccessReadRequest {
  field: unknown;
}

export interface AccessAggregateRequest extends AccessSumRequest {
  method: unknown;
  distinct?: unknown;
}

export interface AccessGroupedAggregateRequest extends AccessAggregateRequest {
  groupBy: unknown;
  limit?: unknown;
  order?: unknown;
}

export interface AccessGroupedAggregateResult {
  readonly key: Readonly<Record<string, unknown>>;
  readonly value: number | null;
}

export interface AccessMultiAggregateRequest extends AccessReadRequest {
  measures: unknown;
  groupBy?: unknown;
  limit?: unknown;
  order?: unknown;
}

type ReadKind = 'list' | 'get' | 'count' | 'sum' | 'aggregate' | 'groupAggregate' | 'aggregateMany';
type ReadRecord = Readonly<Record<string, unknown>>;
const numericTypes = [
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'MEDIUMINT',
  'DECIMAL',
  'FLOAT',
  'DOUBLE',
  'DOUBLE PRECISION',
  'REAL',
];
const scalarTypes = [
  ...numericTypes,
  'STRING',
  'CHAR',
  'TEXT',
  'UUID',
  'ENUM',
  'CITEXT',
  'BOOLEAN',
  'DATE',
  'DATEONLY',
];

export interface AccessReadResult {
  rows: ReadRecord[];
  count?: number;
}

/** Trusted entry constraint, captured separately from client read parameters. */
export interface AccessRootReadConstraint {
  readonly where: WhereOptions;
  readonly bind?: Record<string, unknown>;
  readonly assertCurrent: () => void;
}

export type AccessRootReadConstraintResolver = () => Promise<AccessRootReadConstraint>;

/** Internal execution service. The entry must supply this operation's role/action read grants. */
export class AccessReadService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveGrant: AccessFilterGrantResolver,
    private readonly assertAuthorizationCurrent?: () => void,
    private readonly resolveRootConstraint?: AccessRootReadConstraintResolver,
  ) {}

  async list(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessListRequest,
  ): Promise<ReadRecord[]> {
    const plan = await this.plan(ctx, source, authenticated, request, 'list');
    plan.assertCurrent();
    const rows = await plan.model.findAll(
      internalQuery({ ...plan.query, attributes: plan.attributes, limit: plan.limit, offset: plan.offset }),
    );
    plan.assertCurrent();
    return rows.map((row) => this.project(row, plan.attributes));
  }

  async listWithCount(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessListRequest,
  ) {
    const plan = await this.plan(ctx, source, authenticated, request, 'list');
    plan.assertCurrent();
    const rows = await plan.model.findAll(
      internalQuery({ ...plan.query, attributes: plan.attributes, limit: plan.limit, offset: plan.offset }),
    );
    plan.assertCurrent();
    const count = await this.rootCount(plan);
    return { rows: rows.map((row) => this.project(row, plan.attributes)), count };
  }

  async get(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessGetRequest,
  ): Promise<ReadRecord | null> {
    const plan = await this.plan(ctx, source, authenticated, request, 'get');
    plan.assertCurrent();
    const row = await plan.model.findOne(internalQuery({ ...plan.query, attributes: plan.attributes }));
    plan.assertCurrent();
    return row ? this.project(row, plan.attributes) : null;
  }

  /** Internal assembly page: pairing keys are never added to the authorized output fields. */
  async page(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessListRequest | AccessGetRequest,
    kind: 'list' | 'get',
    withCount = false,
  ) {
    if (withCount && kind !== 'list') invalid('Paged counts require a list operation');
    const plan = await this.plan(ctx, source, authenticated, request, kind, true);
    const primary = plan.model.primaryKeyAttribute;
    if (plan.model.primaryKeyAttributes.length !== 1) invalid('Assembly requires a single root primary key');
    plan.assertCurrent();
    const options = internalQuery({
      ...plan.query,
      attributes: [...new Set([primary, ...plan.attributes])],
      ...(kind === 'list' ? { limit: plan.limit, offset: plan.offset } : { limit: 1 }),
    });
    const rows = await plan.model.findAll(options);
    plan.assertCurrent();
    const count = withCount ? await this.rootCount(plan) : undefined;
    return {
      records: rows.map((row) => ({
        key: normalizeKeys([row.getDataValue(primary)], plan.collection)[0],
        values: this.project(row, plan.attributes),
      })),
      assertCurrent: plan.assertCurrent,
      count,
    };
  }

  async count(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessReadRequest = {},
  ): Promise<number> {
    const plan = await this.plan(ctx, source, authenticated, request, 'count');
    plan.assertCurrent();
    const result = await plan.model.count(internalQuery(plan.query));
    plan.assertCurrent();
    return result;
  }

  async sum(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessSumRequest,
  ): Promise<number | null> {
    const plan = await this.plan(ctx, source, authenticated, request, 'sum');
    plan.assertCurrent();
    const result = await plan.model.sum(plan.field!, internalQuery(plan.query));
    plan.assertCurrent();
    return result;
  }

  /** Internal scalar statistics over scoped roots; group/SQL expressions are not accepted. */
  async aggregate(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessAggregateRequest,
  ): Promise<number | null> {
    const plan = await this.plan(ctx, source, authenticated, request, 'aggregate');
    plan.assertCurrent();
    const result = await plan.model.aggregate<unknown, Model>(plan.field!, plan.method!, {
      ...internalQuery(plan.query),
      distinct: plan.distinct,
      // Actual types are required: ORM normalization leaves type-name strings unchanged.
      ...(plan.method === 'count'
        ? { dataType: DataTypes.INTEGER }
        : plan.method === 'avg'
          ? { dataType: DataTypes.FLOAT }
          : {}),
    });
    plan.assertCurrent();
    if (result === null) return null;
    if (typeof result !== 'number') invalid('Scalar numeric aggregation returned a nonnumeric result');
    return result;
  }

  /** Internal bounded root-field groups, computed in SQL under the same root predicate. */
  async groupAggregate(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessGroupedAggregateRequest,
  ): Promise<AccessGroupedAggregateResult[]> {
    const plan = await this.plan(ctx, source, authenticated, request, 'groupAggregate');
    const rows = await this.executeAggregates(plan, [
      { field: plan.field!, method: plan.method!, distinct: plan.distinct },
    ]);
    return rows.map(({ key, values }) => Object.freeze({ key, value: values[0] }));
  }

  /** All measures share one scoped SQL statement, including when there are no grouping fields. */
  async aggregateMany(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessMultiAggregateRequest,
  ) {
    const plan = await this.plan(ctx, source, authenticated, request, 'aggregateMany');
    return this.executeAggregates(plan, plan.measures);
  }

  private async executeAggregates(
    plan: Awaited<ReturnType<AccessReadService['plan']>>,
    measures: readonly AccessAggregateMeasure[],
  ) {
    const qi = this.db.sequelize.getQueryInterface();
    const column = (name: string) =>
      `${qi.quoteIdentifier(plan.model.name)}.${qi.quoteIdentifier(plan.model.rawAttributes[name].field || name)}`;
    let index = 0;
    const reserved = new Set(Object.keys(plan.model.rawAttributes).map((name) => name.toLowerCase()));
    const nextAlias = () => {
      let alias: string;
      do {
        alias = `tac_aggregate_${index++}`;
      } while (reserved.has(alias));
      reserved.add(alias);
      return alias;
    };
    const aliases = measures.map(nextAlias);
    // Date-formatted groups must not use the model's date attribute alias: Sequelize would parse them as Date.
    const groupAliases = plan.groups.map((group) => (group.format ? nextAlias() : group.field));
    const groupColumns = new Map(
      plan.groups.map((group) => [
        group.field,
        aggregateGroupExpression(
          this.db,
          column(group.field),
          group,
          (plan.model.rawAttributes[group.field].type as { key: string }).key,
        ),
      ]),
    );
    plan.assertCurrent();
    const rows = await plan.model.findAll({
      ...internalQuery(plan.query),
      attributes: [
        ...plan.groupBy.map((name, index): [ReturnType<typeof literal>, string] => [
          literal(groupColumns.get(name)!),
          groupAliases[index],
        ]),
        ...measures.map((measure, index): [ReturnType<typeof literal>, string] => [
          literal(`${measure.method.toUpperCase()}(${measure.distinct ? 'DISTINCT ' : ''}${column(measure.field)})`),
          aliases[index],
        ]),
      ],
      // Sequelize accepts literals here at runtime, but omits them from GroupOption.
      group: plan.groupBy.map((name) => literal(groupColumns.get(name)!)) as unknown as NonNullable<
        Parameters<typeof plan.model.findAll>[0]
      >['group'],
      order: [
        ...plan.aggregateOrder.map((item) =>
          literal(
            `${item.by === 'value' ? qi.quoteIdentifier(aliases[item.index ?? 0]) : groupColumns.get(item.field)!} ${item.direction.toUpperCase()} NULLS LAST`,
          ),
        ),
        ...plan.groupBy
          .filter((name) => !plan.aggregateOrder.some((item) => item.by === 'field' && item.field === name))
          .map((name) => literal(`${groupColumns.get(name)!} ASC NULLS LAST`)),
      ],
      limit: plan.groupBy.length ? plan.limit + 1 : 1,
    });
    plan.assertCurrent();
    if (rows.length > plan.limit) invalid('Grouped aggregate exceeds its group limit');
    if (!plan.groupBy.length && rows.length !== 1) invalid('Scalar aggregate must return exactly one row');
    return rows.map((row) => {
      const values = measures.map((measure, index) => {
        const raw: unknown = row.getDataValue(aliases[index]);
        const value =
          raw === null
            ? null
            : typeof raw === 'number'
              ? raw
              : typeof raw === 'string' && raw.trim() !== ''
                ? Number(raw)
                : NaN;
        if (
          (value !== null && !Number.isFinite(value)) ||
          (measure.method === 'count' && (value === null || !Number.isSafeInteger(value) || value < 0))
        )
          invalid('Grouped aggregate returned an invalid numeric result');
        return value;
      });
      return Object.freeze({
        key: Object.freeze(
          Object.fromEntries(plan.groupBy.map((name, index) => [name, row.getDataValue(groupAliases[index])])),
        ),
        values: Object.freeze(values),
      });
    });
  }

  private project(row: Model, attributes: string[]): ReadRecord {
    // These are fresh query values, not mutation inputs; preserve complete authorized JSON.
    return Object.freeze(Object.fromEntries(attributes.map((name) => [name, row.getDataValue(name)])));
  }

  private async rootCount(plan: Awaited<ReturnType<AccessReadService['plan']>>) {
    // Use the same root predicate, without pagination or order-only target bindings.
    plan.assertCurrent();
    const count = await plan.model.count(internalQuery(plan.rootQuery));
    plan.assertCurrent();
    if (!Number.isSafeInteger(count) || count < 0) invalid('Invalid root record count');
    return count;
  }

  private async plan(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: unknown,
    kind: ReadKind,
    allowEmptyAttributes = false,
  ) {
    const allowed = [
      'filter',
      'transaction',
      ...(kind === 'list'
        ? ['attributes', 'sort', 'limit', 'offset']
        : kind === 'get'
          ? ['attributes', 'key', 'keyField']
          : kind === 'sum'
            ? ['field']
            : kind === 'aggregateMany'
              ? ['measures', 'groupBy', 'limit', 'order']
              : kind === 'aggregate' || kind === 'groupAggregate'
                ? ['field', 'method', 'distinct', ...(kind === 'groupAggregate' ? ['groupBy', 'limit', 'order'] : [])]
                : []),
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
      invalid('Unsupported root read request');
    const requestedLimit = request.limit;
    const requestedOffset = request.offset;
    const measures = kind === 'aggregateMany' ? captureAggregateMeasures(request.measures) : [];
    const aggregateOrder =
      kind === 'groupAggregate' || kind === 'aggregateMany'
        ? captureAggregateOrder(request.order, measures.length || 1)
        : [];
    let method: AggregateMethod | undefined;
    let distinct = false;
    if (kind === 'aggregate' || kind === 'groupAggregate') {
      if (
        typeof request.method !== 'string' ||
        !['avg', 'count', 'min', 'max', 'sum'].includes(request.method) ||
        (request.distinct !== undefined && typeof request.distinct !== 'boolean')
      )
        invalid('Aggregate requires a supported method and a boolean distinct option');
      method = request.method as AggregateMethod;
      distinct = request.distinct === true;
    }
    const groups =
      kind === 'groupAggregate' || kind === 'aggregateMany'
        ? captureAggregateGroups(
            kind === 'aggregateMany' && request.groupBy === undefined ? [] : request.groupBy,
            kind === 'aggregateMany',
          )
        : [];
    const groupBy = groups.map(({ field }) => field);
    source = { ...source };
    authenticated = { ...authenticated };
    const transaction = request.transaction as Transaction | undefined;
    const collection = this.db.getCollection(source.collectionName);
    const config = this.prepared.configuration(ctx, source);
    if (!collection || !config || !this.queries.isCurrentCollection(source, collection))
      invalid('Root reads require a current prepared configuration');
    const model = collection.model;
    const metadataCurrent = accessMetadataGuard(this.db, [{ model, config }]);
    const grants = new Map<string, { collection: Collection; grant: AccessFilterReadGrant | null }>();
    const resolveGrant: AccessFilterGrantResolver = (target, path) => {
      const key = JSON.stringify(path);
      const previous = grants.get(key);
      if (previous) {
        if (previous.collection !== target) invalid('Read grant path changed its collection');
        return previous.grant;
      }
      const grant = cloneDeep(this.resolveGrant(target, Object.freeze([...path])));
      grants.set(key, { collection: target, grant });
      return grant;
    };
    const parsed = new AccessRequestFilterParser(this.db, resolveGrant).parse(
      source,
      request.filter === undefined ? {} : request.filter,
    );
    const rootGrant = resolveGrant(collection, [])!;
    const physical = (field: unknown): field is string =>
      typeof field === 'string' &&
      rootGrant.fields.includes(field) &&
      Object.hasOwn(model.rawAttributes, field) &&
      (model.rawAttributes[field].type as { key?: string }).key !== 'VIRTUAL';
    const attributes: string[] = [];
    if (kind === 'list' || kind === 'get') {
      const input = request.attributes;
      if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        (!allowEmptyAttributes && !input.length) ||
        input.length > 1000 ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        invalid('Select a bounded dense list of physical read attributes');
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, 'value') ||
          !physical(descriptor.value) ||
          attributes.includes(descriptor.value)
        )
          invalid('Read attributes must be distinct authorized physical fields');
        attributes.push(descriptor.value);
      }
    }
    let field: string | undefined;
    if (kind === 'sum' || kind === 'aggregate' || kind === 'groupAggregate') {
      if (
        !physical(request.field) ||
        (method !== 'count' && !numericTypes.includes((model.rawAttributes[request.field].type as { key: string }).key))
      )
        invalid(
          kind === 'sum'
            ? 'Sum requires an authorized physical numeric root field'
            : 'Aggregate requires an authorized physical root field; numeric methods require numeric fields',
        );
      field = request.field;
      if (distinct && !scalarTypes.includes((model.rawAttributes[field].type as { key: string }).key))
        invalid('Distinct aggregation requires a supported scalar field');
    }
    for (const measure of measures) {
      if (
        !physical(measure.field) ||
        (measure.method !== 'count' &&
          !numericTypes.includes((model.rawAttributes[measure.field].type as { key: string }).key)) ||
        (measure.distinct && !scalarTypes.includes((model.rawAttributes[measure.field].type as { key: string }).key))
      )
        invalid('Aggregate requires an authorized physical root field; numeric methods require numeric fields');
    }
    if (kind === 'groupAggregate' || kind === 'aggregateMany') {
      if (
        groupBy.some(
          (name) => !physical(name) || !scalarTypes.includes((model.rawAttributes[name].type as { key: string }).key),
        )
      )
        invalid('Grouping requires distinct authorized physical scalar fields');
      if (aggregateOrder.some((item) => item.by === 'field' && !groupBy.includes(item.field)))
        invalid('Aggregate order requires an authorized grouping field');
      for (const group of groups) {
        const type = (model.rawAttributes[group.field].type as { key: string }).key;
        if (group.format && type !== 'DATE' && type !== 'DATEONLY')
          invalid('Date grouping requires an authorized physical date field');
        if (group.format && !['sqlite', 'postgres'].includes(this.db.sequelize.getDialect()))
          invalid('Date grouping is unsupported for this database');
      }
    }
    const limit =
      (kind === 'list' || kind === 'groupAggregate' || kind === 'aggregateMany') && requestedLimit !== undefined
        ? requestedLimit
        : kind === 'groupAggregate' || kind === 'aggregateMany'
          ? 1000
          : 20;
    const offset = kind === 'list' && requestedOffset !== undefined ? requestedOffset : 0;
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000
    )
      invalid('Root read pagination exceeds supported limits');
    const detailKey = kind === 'get' ? captureReadKey(collection, request.key, request.keyField) : undefined;
    if (detailKey) {
      parsed.filter = {
        type: 'all',
        children: [parsed.filter, { type: 'predicate', where: { [detailKey.field]: { [Op.eq]: detailKey.value } } }],
      };
    }
    const sorting =
      kind === 'list'
        ? new AccessSortService(this.db, this.prepared, this.queries, resolveGrant).prepareRoots(
            ctx,
            source,
            authenticated,
            { sort: request.sort === undefined ? [] : request.sort, transaction },
          )
        : undefined;
    this.assertAuthorizationCurrent?.();
    // Capture all client values and permissions before the source lookup can yield.
    const constraint = this.resolveRootConstraint ? await this.resolveRootConstraint() : undefined;
    if (constraint) {
      constraint.assertCurrent();
      parsed.filter = {
        type: 'all',
        children: [parsed.filter, { type: 'predicate', where: constraint.where, bind: constraint.bind }],
      };
    }
    this.assertAuthorizationCurrent?.();
    const filtered = await new AccessFilterTreeService(this.db, this.prepared, this.queries).scopeRoots(
      ctx,
      source,
      authenticated,
      { ...parsed, transaction, reservedBindNames: sorting?.reservedBindNames },
    );
    const current = () => {
      this.assertAuthorizationCurrent?.();
      constraint?.assertCurrent();
      detailKey?.assertCurrent();
      if (
        this.prepared.configuration(ctx, source) !== config ||
        !this.queries.isCurrentCollection(source, collection, model)
      )
        invalid('Root read phase or collection identity changed');
      metadataCurrent();
      filtered.assertCurrent();
      sorting?.assertCurrent();
    };
    current();
    const sorted = sorting
      ? await sorting.scopeRoots({ sourceWhere: filtered.query.where, sourceBind: filtered.query.bind })
      : undefined;
    const query = sorted?.query ?? filtered.query;
    const assertCurrent = () => {
      current();
      sorted?.assertCurrent();
    };
    assertCurrent();
    const rootQuery = sorted?.rootQuery ?? filtered.query;
    return {
      collection,
      model,
      query,
      rootQuery,
      attributes,
      field,
      method,
      distinct,
      measures,
      groupBy,
      groups,
      aggregateOrder,
      limit,
      offset,
      assertCurrent,
    };
  }
}
