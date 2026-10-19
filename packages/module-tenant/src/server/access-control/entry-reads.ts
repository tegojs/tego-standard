import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { AccessBelongsToExpansionService } from './belongs-to-expansion';
import { parseChartParams } from './chart-params';
import { parseChartQueryParams } from './chart-query-params';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import {
  AccessExpandedReadService,
  type AccessExpandedGetRequest,
  type AccessExpandedListRequest,
} from './expanded-reads';
import { captureAccessFilter } from './filter-input';
import { AccessManyToManyExpansionService } from './many-to-many-expansion';
import { AccessManyToManyReadService } from './many-to-many-reads';
import type { AccessQueryService } from './query';
import { captureReadDateContext, resolveReadDateFilter, type AccessReadDateContext } from './read-date-filter';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from './read-grants';
import { captureReadKey } from './read-key';
import { AccessReadSelectionParser, type AccessAssociationSelection } from './read-selection';
import {
  AccessReadService,
  type AccessAggregateRequest,
  type AccessGetRequest,
  type AccessGroupedAggregateRequest,
  type AccessListRequest,
  type AccessReadRequest,
  type AccessReadResult,
  type AccessRootReadConstraintResolver,
  type AccessSumRequest,
} from './reads';
import { AccessReferenceService } from './references';
import type { AccessFilterReadGrant } from './request-filter';
import {
  parseResourceAssociationGetParams,
  parseResourceCountParams,
  parseResourceGetParams,
  parseResourceListParams,
  parseResourceSumParams,
} from './resource-read-params';
import { resolveResourceReadRoute } from './resource-read-routing';
import { AccessRoleFilterCompiler } from './role-filter';
import { AccessTargetForeignKeyExpansionService } from './target-foreign-key-expansion';
import { AccessTargetForeignKeyReadService } from './target-foreign-key-reads';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessEntryExpansionRequest {
  association: string;
  sourceKeys: Array<string | number>;
  targetAttributes: string[];
  transaction?: Transaction;
}

export type AccessEntryBelongsToExpansionRequest = AccessEntryExpansionRequest;

interface AccessSelectionRequest {
  fields?: unknown;
  appends?: unknown;
  except?: unknown;
}

export interface AccessSelectedListRequest extends Omit<AccessListRequest, 'attributes'>, AccessSelectionRequest {}
export interface AccessSelectedGetRequest extends Omit<AccessGetRequest, 'attributes'>, AccessSelectionRequest {}

type ExpansionKind = 'expandBelongsTo' | 'expandTargetForeignKey' | 'expandManyToMany';

export interface AccessEntryReadOperation {
  readonly kind: 'list' | 'get' | 'count' | 'sum' | 'aggregate' | 'groupAggregate' | ExpansionKind;
  readonly context: object;
  readonly source: Readonly<AccessCollectionIdentity>;
  readonly authenticated: Readonly<AccessIdentity>;
}

/** Internal entry bridge: permissions must already include operation decisions and resolved ACL variables. */
export class AccessEntryReadService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly resolvePermission: (
      collection: Collection,
      path: readonly string[],
      operation: AccessEntryReadOperation,
    ) => AccessEntryReadPermission | null,
  ) {}

  private operation(
    kind: AccessEntryReadOperation['kind'],
    context: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
  ) {
    const operation: AccessEntryReadOperation = Object.freeze({
      kind,
      context,
      source: Object.freeze({ ...source }),
      authenticated: Object.freeze({ ...authenticated }),
    });
    // A fresh checker set per operation prevents concurrent requests from sharing authorization state.
    const checks: Array<() => void> = [];
    const roles = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const adapter = new AccessReadGrantAdapter(this.db, (collection) => {
      const identity = this.resolveIdentity(collection);
      return identity && accessCollectionKey(identity);
    });
    const grants = new Map<
      string,
      {
        collection: Collection;
        plan: ReturnType<AccessReadGrantAdapter['capturePlan']>;
        grant: AccessFilterReadGrant | null;
      }
    >();
    const resolveGrant = (collection: Collection, path: readonly string[]): AccessFilterReadGrant | null => {
      const key = JSON.stringify(path);
      const previous = grants.get(key);
      if (previous) {
        if (previous.collection !== collection) invalid('Entry permission path changed its collection');
        return previous.grant;
      }
      let current = this.db.getCollection(operation.source.collectionName);
      if (!current || path.length > 9) invalid('Entry permission source or path is unavailable');
      let throughCollection: Collection | undefined;
      const ancestors: Array<{ plan: NonNullable<ReturnType<AccessReadGrantAdapter['capturePlan']>>; offset: number }> =
        [];
      for (let index = 0; index < path.length; index++) {
        const parentPath = path.slice(0, index);
        const parent = resolveGrant(current, parentPath);
        if (!parent) return null;
        const through = path[index] === '$through';
        if (through) {
          if (index !== path.length - 1 || !index || throughCollection !== collection)
            invalid('Invalid through permission path');
          break;
        }
        if (!parent.fields.includes(path[index])) return null;
        const relation =
          Object.hasOwn(current.model.associations, path[index]) && current.model.associations[path[index]];
        const target = relation && this.db.modelCollection.get(relation.target);
        if (!target || target.db !== this.db) invalid('Entry permission association is unavailable');
        const throughModel = (relation as typeof relation & { through?: { model?: Collection['model'] } }).through
          ?.model;
        throughCollection = throughModel && this.db.modelCollection.get(throughModel);
        ancestors.push({ plan: grants.get(JSON.stringify(parentPath))!.plan!, offset: index });
        current = target;
      }
      const through = path.at(-1) === '$through';
      if (!through && current !== collection) invalid('Entry permission path does not match its collection');
      const identity = this.resolveIdentity(collection);
      if (!identity) invalid('Entry read collection identity is unavailable');
      const permission = this.resolvePermission(collection, path, operation);
      if (!permission) {
        grants.set(key, { collection, plan: null, grant: null });
        return null;
      }
      // Validate the original descriptors before copying anything: fields/own may be non-enumerable.
      const plan = adapter.capturePlan(identity, permission, roles);
      if (!plan) {
        grants.set(key, { collection, plan: null, grant: null });
        return null;
      }
      checks.push(plan.assertCurrent);
      let fields = plan.grant.fields;
      // Through rows have independent authorization and are never projected as target fields.
      if (!through)
        for (const ancestor of ancestors) fields = ancestor.plan.fieldsAt(path.slice(ancestor.offset), fields);
      const grant = Object.freeze({ ...plan.grant, fields: Object.freeze([...fields]) });
      grants.set(key, { collection, plan, grant });
      // Keep lifecycle functions outside grants: downstream parsers and sorting clone grants as data.
      return grant;
    };
    return {
      source: operation.source,
      authenticated: operation.authenticated,
      resolveGrant,
      assertCurrent: () => {
        for (const check of checks) check();
      },
    };
  }

  private reader(
    kind: 'list' | 'get' | 'count' | 'sum' | 'aggregate' | 'groupAggregate',
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
  ) {
    const authorization = this.operation(kind, ctx, source, authenticated);
    return new AccessReadService(
      this.db,
      this.prepared,
      this.queries,
      authorization.resolveGrant,
      authorization.assertCurrent,
    );
  }

  list(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessListRequest) {
    return this.reader('list', ctx, source, authenticated).list(ctx, source, authenticated, request);
  }

  get(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessGetRequest) {
    return this.reader('get', ctx, source, authenticated).get(ctx, source, authenticated, request);
  }

  aggregate(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessAggregateRequest,
  ) {
    return this.reader('aggregate', ctx, source, authenticated).aggregate(ctx, source, authenticated, request);
  }

  groupAggregate(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessGroupedAggregateRequest,
  ) {
    return this.reader('groupAggregate', ctx, source, authenticated).groupAggregate(
      ctx,
      source,
      authenticated,
      request,
    );
  }

  /** Internal root-chart subset, using the chart's existing collection-list permission contract. */
  async chartFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    return this.executeChart(ctx, source, authenticated, parseChartParams(params), transaction, dates);
  }

  /** Internal full chart envelope. Always performs live reads; no chart middleware/cache is registered here. */
  async chartFromQuery(
    ctx: object,
    authenticated: AccessIdentity,
    values: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const request = parseChartQueryParams(values);
    const identity = { ...authenticated };
    const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
    const route = resolveResourceReadRoute(this.db, this.resolveIdentity, {
      resourceName: request.collection,
      actionName: 'list',
    });
    if (route.kind !== 'direct' || route.identity.dataSourceKey !== request.dataSource)
      invalid('Chart query data source does not match the registered collection identity');
    const rows = await this.executeChart(ctx, route.identity, identity, request.chart, transaction, dateContext);
    route.assertCurrent();
    return rows;
  }

  private async executeChart(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: ReturnType<typeof parseChartParams>,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const { measures, dimensions, filter, limit, order } = params;
    const measure = measures[0];
    const reader = this.reader('list', ctx, source, authenticated);
    const formatted = dimensions.some(({ format }) => format !== undefined);
    if (formatted && dates === undefined) invalid('Chart date grouping requires a trusted date context');
    if (measures.length > 1 || formatted) {
      const request = this.withDates(source, { filter }, dates);
      const groupBy = dimensions.map(({ field, format }) =>
        format === undefined ? field : { field, format, timezone: dates!.timezone },
      );
      const rows = await reader.aggregateMany(ctx, source, authenticated, {
        ...request,
        transaction,
        measures: measures.map(({ field, method }) => ({ field, method })),
        groupBy,
        limit,
        order,
      });
      return rows.map(({ key, values }) =>
        Object.freeze(
          Object.fromEntries([
            ...dimensions.map(({ field, alias }) => [alias, key[field]]),
            ...measures.map(({ alias }, index) => [alias, values[index]]),
          ]),
        ),
      );
    }
    const request = {
      ...this.withDates(source, { field: measure.field, method: measure.method, filter }, dates),
      transaction,
    };
    if (!dimensions.length) {
      const value = await reader.aggregate(ctx, source, authenticated, request);
      return [Object.freeze(Object.fromEntries([[measure.alias, value]]))];
    }
    const rows = await reader.groupAggregate(ctx, source, authenticated, {
      ...request,
      groupBy: dimensions.map(({ field }) => field),
      limit,
      order,
    });
    return rows.map(({ key, value }) =>
      Object.freeze(
        Object.fromEntries([...dimensions.map(({ field, alias }) => [alias, key[field]]), [measure.alias, value]]),
      ),
    );
  }

  /** Internal parsed-resource bridge; callers supply authentication and wrap the final HTTP response. */
  async fromResource(
    ctx: object,
    authenticated: AccessIdentity,
    action: unknown,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const route = resolveResourceReadRoute(this.db, this.resolveIdentity, action);
    if (route.kind === 'association') {
      const args = [ctx, route.identity, authenticated, route.association, params, transaction, dates] as const;
      const result = await (route.actionName === 'list'
        ? this.listAssociationPageFromParams(...args)
        : route.actionName === 'get'
          ? this.getAssociationFromParams(...args)
          : this.countAssociationFromParams(...args));
      route.assertCurrent();
      return result;
    }
    const args = [ctx, route.identity, authenticated, params, transaction, dates] as const;
    const result = await (route.actionName === 'list'
      ? this.listPageFromParams(...args)
      : route.actionName === 'get'
        ? this.getFromParams(...args)
        : route.actionName === 'count'
          ? this.countFromParams(...args)
          : this.sumFromParams(...args));
    route.assertCurrent();
    return result;
  }

  /** Internal action-param bridge; response envelopes belong to the caller. */
  async listFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const request = this.withDates(source, parseResourceListParams(params), dates);
    return this.listSelected(ctx, source, authenticated, { ...request, transaction });
  }

  async listPageFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const request = this.withDates(source, parseResourceListParams(params), dates);
    const page = request.offset / request.limit + 1;
    const pageSize = request.limit;
    const result = await this.selected(ctx, source, authenticated, { ...request, transaction }, 'list', true);
    if (result.count === undefined) invalid('Selected page is missing its root count');
    return { rows: result.rows, count: result.count, page, pageSize, totalPage: Math.ceil(result.count / pageSize) };
  }

  /** Internal concrete-source multi-record relation bridge; no business resource route is installed here. */
  async listAssociationPageFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    descriptor: unknown,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const { request, authorization, scope } = this.associationSelection(
      'list',
      ctx,
      source,
      authenticated,
      descriptor,
      () => parseResourceListParams(params),
      transaction,
      dates,
    );
    const result = await this.selected(
      ctx,
      authorization.source,
      authorization.authenticated,
      request,
      'list',
      true,
      scope,
    );
    authorization.assertCurrent();
    if (result.count === undefined) invalid('Association page is missing its root count');
    const pageSize = request.limit;
    return {
      rows: result.rows,
      count: result.count,
      page: request.offset / pageSize + 1,
      pageSize,
      totalPage: Math.ceil(result.count / pageSize),
    };
  }

  /** Internal concrete-source relationship detail bridge; no business route is installed. */
  async getAssociationFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    descriptor: unknown,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const { request, authorization, scope } = this.associationSelection(
      'get',
      ctx,
      source,
      authenticated,
      descriptor,
      (_target, single) => ({ ...parseResourceAssociationGetParams(params, single), limit: 1, offset: 0 }),
      transaction,
      dates,
    );
    // The relation adapter supplies its own locator protocol. Execute a bounded page under GET authorization.
    const result = await this.selected(
      ctx,
      authorization.source,
      authorization.authenticated,
      request,
      'list',
      false,
      scope,
    );
    authorization.assertCurrent();
    return result.rows[0] ?? null;
  }

  /** Internal multi-record association count; final permissions belong to the count operation. */
  async countAssociationFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    descriptor: unknown,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const { request, authorization, scope } = this.associationSelection(
      'count',
      ctx,
      source,
      authenticated,
      descriptor,
      () => parseResourceCountParams(params),
      transaction,
      dates,
    );
    const reader = new AccessReadService(
      this.db,
      this.prepared,
      this.queries,
      authorization.resolveGrant,
      authorization.assertCurrent,
      scope.rootConstraint,
    );
    return reader.count(ctx, authorization.source, authorization.authenticated, request);
  }

  /** Internal sum contract only; does not install or emulate a generic aggregate action. */
  async sumAssociationFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    descriptor: unknown,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const { request, authorization, scope } = this.associationSelection(
      'sum',
      ctx,
      source,
      authenticated,
      descriptor,
      () => parseResourceSumParams(params),
      transaction,
      dates,
    );
    const reader = new AccessReadService(
      this.db,
      this.prepared,
      this.queries,
      authorization.resolveGrant,
      authorization.assertCurrent,
      scope.rootConstraint,
    );
    return reader.sum(ctx, authorization.source, authorization.authenticated, request);
  }

  /** Internal scalar statistics for a concrete multi-record relation; no aggregate resource action. */
  async aggregateAssociation(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    descriptor: unknown,
    input: Omit<AccessAggregateRequest, 'transaction'>,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    if (
      !plain(input) ||
      Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== 'string' ||
          !['method', 'field', 'distinct', 'filter'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
      )
    )
      invalid('Unsupported association aggregate request');
    // Capture before any permission callback or source lookup can mutate caller-owned parameters.
    const captured = {
      method: input.method,
      field: input.field,
      distinct: input.distinct,
      filter: captureAccessFilter(input.filter === undefined ? {} : input.filter),
    };
    const { request, authorization, scope } = this.associationSelection(
      'aggregate',
      ctx,
      source,
      authenticated,
      descriptor,
      () => captured,
      transaction,
      dates,
    );
    const reader = new AccessReadService(
      this.db,
      this.prepared,
      this.queries,
      authorization.resolveGrant,
      authorization.assertCurrent,
      scope.rootConstraint,
    );
    return reader.aggregate(ctx, authorization.source, authorization.authenticated, request);
  }

  private associationSelection<T extends { filter?: unknown; key?: string | number }>(
    kind: 'list' | 'get' | 'count' | 'sum' | 'aggregate',
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    descriptor: unknown,
    parse: (target: Collection, single: boolean) => T,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    if (
      !plain(descriptor) ||
      Reflect.ownKeys(descriptor).some(
        (key) =>
          typeof key !== 'string' ||
          !['association', 'sourceKey'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(descriptor, key)!, 'value'),
      )
    )
      invalid('Unsupported association read descriptor');
    const name = Object.getOwnPropertyDescriptor(descriptor, 'association')?.value;
    const sourceKey = Object.getOwnPropertyDescriptor(descriptor, 'sourceKey')?.value;
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 255 || sourceKey === '_')
      invalid('Select a direct association and a concrete source key');
    const authorization = this.operation(kind, ctx, source, authenticated);
    const collection = this.db.getCollection(authorization.source.collectionName);
    const field = collection?.getField(name);
    const relation =
      collection && Object.hasOwn(collection.model.associations, name) && collection.model.associations[name];
    const target = relation && this.db.modelCollection.get(relation.target);
    if (
      !collection ||
      !field ||
      !relation ||
      (!['HasMany', 'BelongsToMany'].includes(relation.associationType) &&
        !(kind === 'get' && ['HasOne', 'BelongsTo'].includes(relation.associationType))) ||
      !target ||
      target.db !== this.db ||
      field.target !== target.name
    )
      invalid('Select a supported same-database association');
    const targetKeyField = field.options.targetKey || target.model.primaryKeyAttribute;
    const sourceKeyField = field.options.sourceKey || collection.model.primaryKeyAttribute;
    if (relation.associationType === 'BelongsTo' && sourceKeyField !== collection.model.primaryKeyAttribute)
      invalid('Association details require a primary source key');
    if (kind === 'get' && relation.associationType === 'HasMany' && targetKeyField !== target.model.primaryKeyAttribute)
      invalid('Association details require a primary target key');
    const sourceGrant = authorization.resolveGrant(collection, []);
    const targetGrant = authorization.resolveGrant(target, [name]);
    if (!sourceGrant || !targetGrant || !sourceGrant.fields.includes(name))
      invalid('Association read is not authorized');
    if (accessCollectionKey(sourceGrant.identity) !== accessCollectionKey(authorization.source))
      invalid('Association source permission does not match the requested collection');
    const manyToMany = relation.associationType === 'BelongsToMany';
    const throughModel = manyToMany
      ? (relation as typeof relation & { through?: { model?: Collection['model'] } }).through?.model
      : undefined;
    const through = throughModel && this.db.modelCollection.get(throughModel);
    const throughGrant = through ? authorization.resolveGrant(through, [name, '$through']) : undefined;
    if (manyToMany && !throughGrant) invalid('Association through read is not authorized');
    const { key, ...parsed } = parse(target, ['HasOne', 'BelongsTo'].includes(relation.associationType));
    const detailKey = manyToMany && kind === 'get' ? captureReadKey(target, key, target.filterTargetKey) : undefined;
    const request = {
      ...this.withDates(targetGrant.identity, parsed, dates),
      transaction,
    };
    const relationArgs = [
      ctx,
      authorization.source,
      targetGrant.identity,
      authorization.authenticated,
      {
        association: name,
        sourceKey,
        targetKey: key,
        sourceWhere: sourceGrant.where,
        sourceBind: sourceGrant.bind,
        transaction,
      },
    ] as const;
    const plan = manyToMany
      ? new AccessManyToManyReadService(this.db, this.prepared, this.queries).prepareTargets(
          ctx,
          authorization.source,
          targetGrant.identity,
          throughGrant!.identity,
          authorization.authenticated,
          {
            association: name,
            sourceKey,
            sourceWhere: sourceGrant.where,
            sourceBind: sourceGrant.bind,
            throughWhere: throughGrant!.where,
            throughBind: throughGrant!.bind,
            ...(detailKey ? { targetWhere: { [detailKey.field]: detailKey.value } } : {}),
            transaction,
          },
        )
      : relation.associationType === 'BelongsTo'
        ? new AccessReferenceService(this.db, this.prepared, this.queries).prepareBelongsToTarget(...relationArgs)
        : new AccessTargetForeignKeyReadService(this.db, this.prepared, this.queries).prepareTargets(...relationArgs);
    const targetAuthorization = {
      ...authorization,
      source: targetGrant.identity,
      resolveGrant: (collection: Collection, path: readonly string[]) =>
        authorization.resolveGrant(collection, [name, ...path]),
      assertCurrent: () => {
        authorization.assertCurrent();
        plan.assertCurrent();
        detailKey?.assertCurrent();
        if (
          collection.getField(name) !== field ||
          field.target !== target.name ||
          (relation.associationType === 'BelongsTo' &&
            (field.options.sourceKey || collection.model.primaryKeyAttribute) !== sourceKeyField) ||
          (kind === 'get' &&
            relation.associationType === 'HasMany' &&
            (field.options.targetKey || target.model.primaryKeyAttribute) !== targetKeyField)
        )
          invalid('Association read field changed during query');
      },
    };
    return {
      request,
      authorization: targetAuthorization,
      scope: { authorization: targetAuthorization, rootConstraint: plan.resolve },
    };
  }

  async getFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const request = { ...this.withDates(source, parseResourceGetParams(params), dates), transaction };
    const identity = { ...source };
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || collection.db !== this.db) invalid('Resource detail collection is unavailable');
    const primary = collection.model.primaryKeyAttribute;
    const keyField = collection.filterTargetKey;
    if (!keyField) invalid('Resource detail target key is unavailable');
    const assertTargetKey = () => {
      if (
        this.db.getCollection(identity.collectionName) !== collection ||
        collection.model.primaryKeyAttributes.length !== 1 ||
        collection.model.primaryKeyAttribute !== primary ||
        collection.filterTargetKey !== keyField
      )
        invalid('Resource detail target key changed during query');
    };
    assertTargetKey();
    const record = await this.getSelected(ctx, identity, authenticated, { ...request, keyField });
    assertTargetKey();
    return record;
  }

  async countFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const request = this.withDates(source, parseResourceCountParams(params), dates);
    return this.count(ctx, source, authenticated, { ...request, transaction });
  }

  async sumFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const request = this.withDates(source, parseResourceSumParams(params), dates);
    return this.sum(ctx, source, authenticated, { ...request, transaction });
  }

  private withDates<T extends { filter?: unknown }>(
    source: AccessCollectionIdentity,
    request: T,
    dates?: AccessReadDateContext,
  ): T {
    if (dates === undefined) return request;
    return {
      ...request,
      filter: resolveReadDateFilter(
        request.filter === undefined ? {} : request.filter,
        dates,
        (path) => this.db.getFieldByPath(`${source.collectionName}.${path.join('.')}`)?.timezone,
      ),
    };
  }

  async listSelected(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessSelectedListRequest,
  ) {
    return (await this.selected(ctx, source, authenticated, request, 'list')).rows;
  }

  async getSelected(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessSelectedGetRequest,
  ) {
    return (await this.selected(ctx, source, authenticated, request, 'get')).rows[0] ?? null;
  }

  private async selected(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessSelectedListRequest | AccessSelectedGetRequest,
    kind: 'list' | 'get',
    withCount = false,
    scope?: {
      authorization: ReturnType<AccessEntryReadService['operation']>;
      rootConstraint: AccessRootReadConstraintResolver;
    },
  ): Promise<AccessReadResult> {
    const selectionKeys = ['fields', 'appends', 'except'];
    const allowed = [
      ...selectionKeys,
      'filter',
      'transaction',
      ...(kind === 'list' ? ['sort', 'limit', 'offset'] : ['key', 'keyField']),
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
      invalid('Unsupported selected read request');
    const captured = Reflect.ownKeys(request).map(
      (key) => [key, Object.getOwnPropertyDescriptor(request, key)!.value] as const,
    );
    const ownValues = (selection: boolean) =>
      Object.fromEntries(captured.filter(([key]) => selectionKeys.includes(key as string) === selection));
    const authorization = scope?.authorization ?? this.operation(kind, ctx, source, authenticated);
    const collection = this.db.getCollection(authorization.source.collectionName);
    if (!collection) invalid('Selected read collection is unavailable');
    // Selection and subsequent filter/sort/expansion share one operation-local permission snapshot.
    const resolveGrant = authorization.resolveGrant;
    const selection = new AccessReadSelectionParser(this.db, resolveGrant).parse(collection, ownValues(true));
    // Keep original filter/sort values for their strict validation; copying first could normalize bad inputs.
    const input = { ...ownValues(false), attributes: selection.attributes };
    if (selection.expansions.length) {
      const project = (child: AccessAssociationSelection): object => ({
        association: child.association,
        attributes: child.attributes,
        ...(child.expansions.length ? { expansions: child.expansions.map(project) } : {}),
      });
      const reader = new AccessExpandedReadService(
        this.db,
        this.prepared,
        this.queries,
        resolveGrant,
        authorization.assertCurrent,
        scope?.rootConstraint,
      );
      const expanded = { ...input, expansions: selection.expansions.map(project) };
      if (kind === 'list') {
        const args = [
          ctx,
          authorization.source,
          authorization.authenticated,
          expanded as AccessExpandedListRequest,
        ] as const;
        return withCount ? reader.listWithCount(...args) : { rows: await reader.list(...args) };
      }
      const record = await reader.get(
        ctx,
        authorization.source,
        authorization.authenticated,
        expanded as AccessExpandedGetRequest,
      );
      return { rows: record ? [record] : [] };
    }
    const reader = new AccessReadService(
      this.db,
      this.prepared,
      this.queries,
      resolveGrant,
      authorization.assertCurrent,
      scope?.rootConstraint,
    );
    if (kind === 'list') {
      if (withCount) {
        return reader.listWithCount(ctx, authorization.source, authorization.authenticated, input as AccessListRequest);
      }
      return {
        rows: await reader.list(ctx, authorization.source, authorization.authenticated, input as AccessListRequest),
      };
    }
    const record = await reader.get(ctx, authorization.source, authorization.authenticated, input as AccessGetRequest);
    return { rows: record ? [record] : [] };
  }

  listExpanded(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessExpandedListRequest,
  ) {
    const authorization = this.operation('list', ctx, source, authenticated);
    return new AccessExpandedReadService(
      this.db,
      this.prepared,
      this.queries,
      authorization.resolveGrant,
      authorization.assertCurrent,
    ).list(ctx, authorization.source, authorization.authenticated, request);
  }

  getExpanded(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessExpandedGetRequest,
  ) {
    const authorization = this.operation('get', ctx, source, authenticated);
    return new AccessExpandedReadService(
      this.db,
      this.prepared,
      this.queries,
      authorization.resolveGrant,
      authorization.assertCurrent,
    ).get(ctx, authorization.source, authorization.authenticated, request);
  }

  count(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessReadRequest = {}) {
    return this.reader('count', ctx, source, authenticated).count(ctx, source, authenticated, request);
  }

  sum(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessSumRequest) {
    return this.reader('sum', ctx, source, authenticated).sum(ctx, source, authenticated, request);
  }

  private expansion(
    kind: ExpansionKind,
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessEntryExpansionRequest,
    types: readonly string[],
  ) {
    if (
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          !['association', 'sourceKeys', 'targetAttributes', 'transaction'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
      )
    )
      invalid('Unsupported entry association expansion input');
    for (const name of ['sourceKeys', 'targetAttributes'] as const) {
      const values = request[name];
      if (
        !Array.isArray(values) ||
        Object.getPrototypeOf(values) !== Array.prototype ||
        values.length > 1000 ||
        Reflect.ownKeys(values).length !== values.length + 1
      )
        invalid('Expansion arrays must be bounded and dense');
      for (let index = 0; index < values.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(values, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Expansion arrays cannot contain accessors');
      }
    }
    const input = {
      association: request.association,
      sourceKeys: cloneDeep(request.sourceKeys),
      targetAttributes: cloneDeep(request.targetAttributes),
      transaction: request.transaction,
    };
    if (
      typeof input.association !== 'string' ||
      !input.association ||
      input.sourceKeys.includes('_') ||
      !input.targetAttributes.length ||
      new Set(input.targetAttributes).size !== input.targetAttributes.length
    )
      invalid('Select a direct association and distinct target attributes');
    const authorization = this.operation(kind, ctx, source, authenticated);
    const collection = this.db.getCollection(authorization.source.collectionName);
    const association =
      collection && Object.hasOwn(collection.model.associations, input.association)
        ? collection.model.associations[input.association]
        : undefined;
    const target = association && this.db.modelCollection.get(association.target);
    if (!collection || !association || !types.includes(association.associationType) || !target || target.db !== this.db)
      invalid('Select a registered same-database association of the requested type');
    const sourceGrant = authorization.resolveGrant(collection, Object.freeze([]));
    const targetGrant = authorization.resolveGrant(target, Object.freeze([input.association]));
    if (!sourceGrant || !sourceGrant.fields.includes(input.association) || !targetGrant)
      invalid('Association expansion is not authorized');
    if (
      sourceGrant.identity.collectionName !== authorization.source.collectionName ||
      accessCollectionKey(sourceGrant.identity) !== accessCollectionKey(authorization.source)
    )
      invalid('Source expansion permission does not match the requested collection');
    if (
      input.targetAttributes.some(
        (field) =>
          typeof field !== 'string' ||
          !targetGrant.fields.includes(field) ||
          !Object.hasOwn(target.model.rawAttributes, field) ||
          (target.model.rawAttributes[field].type as { key?: string }).key === 'VIRTUAL',
      )
    )
      invalid('Expansion attributes must be authorized physical target fields');
    return {
      association,
      authorization,
      targetGrant,
      request: {
        ...input,
        sourceWhere: sourceGrant.where,
        sourceBind: sourceGrant.bind,
        targetWhere: targetGrant.where,
        targetBind: targetGrant.bind,
      },
    };
  }

  async expandBelongsTo(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessEntryBelongsToExpansionRequest,
  ) {
    const plan = this.expansion('expandBelongsTo', ctx, source, authenticated, request, ['BelongsTo']);
    return new AccessBelongsToExpansionService(
      this.db,
      this.prepared,
      this.queries,
      plan.authorization.assertCurrent,
    ).load(ctx, plan.authorization.source, plan.targetGrant.identity, plan.authorization.authenticated, plan.request);
  }

  async expandTargetForeignKey(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessEntryExpansionRequest,
  ) {
    const plan = this.expansion('expandTargetForeignKey', ctx, source, authenticated, request, ['HasMany', 'HasOne']);
    return new AccessTargetForeignKeyExpansionService(
      this.db,
      this.prepared,
      this.queries,
      plan.authorization.assertCurrent,
    ).load(ctx, plan.authorization.source, plan.targetGrant.identity, plan.authorization.authenticated, plan.request);
  }

  async expandManyToMany(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessEntryExpansionRequest,
  ) {
    const plan = this.expansion('expandManyToMany', ctx, source, authenticated, request, ['BelongsToMany']);
    const association = plan.association as typeof plan.association & { through?: { model?: Collection['model'] } };
    const through = association.through?.model && this.db.modelCollection.get(association.through.model);
    if (!through || through.db !== this.db) invalid('Expansion through collection is unavailable');
    const throughGrant = plan.authorization.resolveGrant(
      through,
      Object.freeze([plan.request.association, '$through']),
    );
    if (!throughGrant) invalid('Through expansion is not authorized');
    return new AccessManyToManyExpansionService(
      this.db,
      this.prepared,
      this.queries,
      plan.authorization.assertCurrent,
    ).load(
      ctx,
      plan.authorization.source,
      plan.targetGrant.identity,
      throughGrant.identity,
      plan.authorization.authenticated,
      { ...plan.request, throughWhere: throughGrant.where, throughBind: throughGrant.bind },
    );
  }
}
