import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { AccessBelongsToExpansionService } from './belongs-to-expansion';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessManyToManyExpansionService } from './many-to-many-expansion';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from './read-grants';
import {
  AccessReadService,
  type AccessGetRequest,
  type AccessListRequest,
  type AccessReadRequest,
  type AccessSumRequest,
} from './reads';
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
    return {
      source: operation.source,
      authenticated: operation.authenticated,
      resolveGrant: (collection: Collection, path: readonly string[]) => {
        const identity = this.resolveIdentity(collection);
        if (!identity) invalid('Entry read collection identity is unavailable');
        const permission = this.resolvePermission(collection, path, operation);
        if (!permission) return null;
        // Validate the original descriptors before copying anything: fields/own may be non-enumerable.
        const plan = adapter.capturePlan(identity, permission, roles);
        if (!plan) return null;
        checks.push(plan.assertCurrent);
        // Keep lifecycle functions outside grants: downstream parsers and sorting clone grants as data.
        return plan.grant;
      },
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
