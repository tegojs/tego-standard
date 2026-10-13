import { literal, Op, type Collection, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { compileAccessScopes } from './compile';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { resolveAccessContext, type AccessIdentity } from './context';
import { resolveModelMetadata } from './model-metadata';
import { AccessRuleError, type AccessConfig, type AccessScopes } from './types';

export interface AccessPredicateQuery {
  where?: WhereOptions;
  bind?: Record<string, unknown>;
  transaction?: Transaction;
  rootAlias?: string;
}

export interface ResolvedAccessScopes {
  config: AccessConfig;
  scopes: AccessScopes;
}

export interface ScopedAccessQuery extends ResolvedAccessScopes {
  query: Pick<AccessPredicateQuery, 'where' | 'bind' | 'transaction'>;
}

/** Internal root predicate service; entry adapters remain responsible for associations and mutations. */
export class AccessQueryService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly resolveCollectionKey: (collection: Collection) => string,
  ) {}

  /** Synchronous lifecycle check for adapters across their own authorization/write awaits. */
  isCurrentCollection(identity: AccessCollectionIdentity, collection: Collection, model = collection.model): boolean {
    return (
      collection.db === this.db &&
      this.db.getCollection(identity.collectionName) === collection &&
      collection.model === model &&
      this.resolveCollectionKey(collection) === accessCollectionKey(identity)
    );
  }

  async resolveScopes(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    options: { rootAlias?: string; parameterPrefix?: string; transaction?: Transaction } = {},
  ): Promise<ResolvedAccessScopes | null> {
    identity = { ...identity };
    const config = this.prepared.configuration(ctx, identity);
    if (!config) return null;
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || collection.db !== this.db) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access query collection identity is unavailable');
    }
    const key = accessCollectionKey(identity);
    const model = collection.model;
    if (this.resolveCollectionKey(collection) !== key) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access query model identity does not match its configuration');
    }
    const { transaction, rootAlias = collection.model.name, parameterPrefix } = options;
    const context = await resolveAccessContext(this.db, config, { ...authenticated }, { transaction });
    // An ended or replaced phase cannot publish a late authorization result.
    if (this.prepared.configuration(ctx, identity) !== config) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access query phase changed during scope resolution');
    }
    if (
      this.db.getCollection(identity.collectionName) !== collection ||
      collection.model !== model ||
      this.resolveCollectionKey(collection) !== key
    ) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access query model identity changed during scope resolution');
    }
    const metadata = resolveModelMetadata(collection, { resolveCollectionKey: this.resolveCollectionKey });
    const queryInterface = this.db.sequelize.getQueryInterface();
    return {
      config,
      scopes: compileAccessScopes(config, {
        collection: metadata,
        context,
        rootAlias,
        parameterPrefix,
        quoteIdentifier: (name) => queryInterface.quoteIdentifier(name),
      }),
    };
  }

  async scopeQuery(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    options: AccessPredicateQuery = {},
    kind: 'read' | 'ownership' = 'read',
  ): Promise<ScopedAccessQuery | null> {
    options = { ...options };
    if (!this.prepared.configuration(ctx, identity)) return null;
    if (kind !== 'read' && kind !== 'ownership') {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Unsupported access query scope');
    }
    if (
      options.bind !== undefined &&
      (!options.bind ||
        typeof options.bind !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options.bind)))
    ) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access queries require named SQL bindings');
    }
    const bind = { ...options.bind };
    const keys = Object.keys(bind);
    let index = 0;
    let parameterPrefix: string;
    do {
      parameterPrefix = `tac_scope${index++}_`;
    } while (keys.some((key) => key.startsWith(parameterPrefix)));
    const resolved = await this.resolveScopes(ctx, identity, authenticated, { ...options, parameterPrefix });
    if (!resolved) return null;
    const scope = resolved.scopes[kind];
    return {
      ...resolved,
      query: {
        where: options.where === undefined ? literal(scope.sql) : { [Op.and]: [options.where, literal(scope.sql)] },
        bind: { ...bind, ...scope.bind },
        transaction: options.transaction,
      },
    };
  }
}
