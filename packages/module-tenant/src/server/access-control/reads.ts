import { Op, type Collection, type Database, type Model, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
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

type ReadKind = 'list' | 'get' | 'count' | 'sum';
type ReadRecord = Readonly<Record<string, unknown>>;

export interface AccessReadResult {
  rows: ReadRecord[];
  count?: number;
}

/** Trusted entry constraint, captured separately from client read parameters. */
export interface AccessRootReadConstraint {
  readonly where: WhereOptions;
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
    if (kind === 'sum') {
      if (
        !physical(request.field) ||
        !['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL'].includes(
          (model.rawAttributes[request.field].type as { key: string }).key,
        )
      )
        invalid('Sum requires an authorized physical numeric root field');
      field = request.field;
    }
    const limit = kind === 'list' && request.limit !== undefined ? request.limit : 20;
    const offset = kind === 'list' && request.offset !== undefined ? request.offset : 0;
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
        children: [parsed.filter, { type: 'predicate', where: constraint.where }],
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
    return { collection, model, query, rootQuery, attributes, field, limit, offset, assertCurrent };
  }
}
