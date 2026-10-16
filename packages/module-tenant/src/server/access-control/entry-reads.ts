import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { AccessBelongsToExpansionService } from './belongs-to-expansion';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import {
  AccessExpandedReadService,
  type AccessExpandedGetRequest,
  type AccessExpandedListRequest,
} from './expanded-reads';
import { AccessManyToManyExpansionService } from './many-to-many-expansion';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from './read-grants';
import { AccessReadSelectionParser, type AccessAssociationSelection } from './read-selection';
import {
  AccessReadService,
  type AccessGetRequest,
  type AccessListRequest,
  type AccessReadRequest,
  type AccessReadResult,
  type AccessSumRequest,
} from './reads';
import type { AccessFilterReadGrant } from './request-filter';
import { parseResourceGetParams, parseResourceListParams } from './resource-read-params';
import { AccessRoleFilterCompiler } from './role-filter';
import { AccessTargetForeignKeyExpansionService } from './target-foreign-key-expansion';
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
  readonly kind: 'list' | 'get' | 'count' | 'sum' | ExpansionKind;
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
    kind: 'list' | 'get' | 'count' | 'sum',
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

  /** Internal action-param bridge; response envelopes and resource routing belong to the caller. */
  async listFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
  ) {
    return this.listSelected(ctx, source, authenticated, { ...parseResourceListParams(params), transaction });
  }

  async listPageFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
  ) {
    const request = parseResourceListParams(params);
    const page = request.offset / request.limit + 1;
    const pageSize = request.limit;
    const result = await this.selected(ctx, source, authenticated, { ...request, transaction }, 'list', true);
    if (result.count === undefined) invalid('Selected page is missing its root count');
    return { rows: result.rows, count: result.count, page, pageSize, totalPage: Math.ceil(result.count / pageSize) };
  }

  async getFromParams(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    params: unknown,
    transaction?: Transaction,
  ) {
    const request = { ...parseResourceGetParams(params), transaction };
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
    const authorization = this.operation(kind, ctx, source, authenticated);
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
