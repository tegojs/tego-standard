import { isDeepStrictEqual } from 'node:util';
import { literal, Op, type Collection, type Database, type Transaction, type WhereOptions } from '@tego/server';

import { TENANT_INHERITED_MODE, TENANT_SCOPED_MODE } from '../constants';
import type { AccessAclScopeAdapter } from './acl-scope';
import { compileAccessScopes } from './compile';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { requiresAccessContext, resolveAccessContext, type AccessIdentity } from './context';
import { normalizeAccessContextValue } from './context-values';
import { accessMetadataGuard } from './metadata-snapshot';
import { resolveModelMetadata } from './model-metadata';
import { AccessRuleError, type AccessCondition, type AccessConfig, type AccessScopes } from './types';

export interface AccessPredicateQuery {
  where?: WhereOptions;
  bind?: Record<string, unknown>;
  transaction?: Transaction;
  rootAlias?: string;
  /** Names used by a later composed plan; reserve them without adding unused SQL bindings. */
  reservedBindNames?: readonly string[];
}

export interface ResolvedAccessScopes {
  config: AccessConfig;
  scopes: AccessScopes;
}

export interface ScopedAccessQuery extends ResolvedAccessScopes {
  query: Pick<AccessPredicateQuery, 'where' | 'bind' | 'transaction'>;
}

interface ResolveScopeOptions {
  rootAlias?: string;
  parameterPrefix?: string;
  transaction?: Transaction;
}

interface TenantBoundaryPolicy {
  mode: typeof TENANT_SCOPED_MODE | typeof TENANT_INHERITED_MODE;
  legacyDataTenantIds: string[];
  allowEditingLegacyData: boolean;
}

function tenantBoundaryPolicy(collection: Collection): TenantBoundaryPolicy | undefined {
  const mode = collection.options.tenancy;
  if (mode !== TENANT_SCOPED_MODE && mode !== TENANT_INHERITED_MODE) return undefined;
  const legacyDataTenantIds = collection.options.legacyDataTenantIds;
  return {
    mode,
    legacyDataTenantIds:
      legacyDataTenantIds == null
        ? []
        : (normalizeAccessContextValue('tenant.descendantIds', legacyDataTenantIds) as string[]),
    allowEditingLegacyData: collection.options.allowEditingLegacyData === true,
  };
}

function tenantBoundaries(policy: TenantBoundaryPolicy, tenantId: string) {
  const tenant = { type: 'field', path: 'tenantId' } as const;
  const owned: AccessCondition = {
    type: 'tenantRelation',
    tenant,
    relation: policy.mode === TENANT_INHERITED_MODE ? 'ancestor' : 'same',
    includeSelf: true,
  };
  const canReadLegacy = policy.legacyDataTenantIds.includes(tenantId);
  const withLegacy: AccessCondition = canReadLegacy
    ? { type: 'any', children: [owned, { type: 'isNull', operand: tenant }] }
    : owned;
  return {
    ownership: canReadLegacy && policy.allowEditingLegacyData ? withLegacy : owned,
    visibility: withLegacy,
  };
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

  /** Prove context-independent, unrestricted G using the compiler's constant normal form; no SQL is executed. */
  hasUnconditionalOwnership(ctx: object, identity: AccessCollectionIdentity): boolean {
    const config = this.prepared.configuration(ctx, identity);
    if (!config || config.ownership.enabled || requiresAccessContext(config)) return false;
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || !this.isCurrentCollection(identity, collection))
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access query model identity does not match its configuration');
    if (tenantBoundaryPolicy(collection)) return false;
    const metadata = resolveModelMetadata(collection, { resolveCollectionKey: this.resolveCollectionKey });
    const queryInterface = this.db.sequelize.getQueryInterface();
    const { ownership } = compileAccessScopes(config, {
      collection: metadata,
      context: {},
      quoteIdentifier: (name) => queryInterface.quoteIdentifier(name),
    });
    if (this.prepared.configuration(ctx, identity) !== config || !this.isCurrentCollection(identity, collection))
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Access query phase or model identity changed');
    return ownership.sql === 'TRUE' && Object.keys(ownership.bind).length === 0;
  }

  async resolveScopes(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    options: ResolveScopeOptions = {},
  ): Promise<ResolvedAccessScopes | null> {
    return this.resolveCompiledScopes(ctx, identity, authenticated, options, false);
  }

  /** Internal predicate snapshot, not action authorization or a deletion/cleanup lease.
   * Consumers must intersect final ACL and omit ORM bind options entirely.
   */
  async resolveNativeScopes(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    options: Omit<ResolveScopeOptions, 'parameterPrefix'> = {},
  ): Promise<ResolvedAccessScopes | null> {
    if (!['sqlite', 'postgres'].includes(this.db.sequelize.getDialect()))
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Native access scopes require an explicitly supported dialect');
    return this.resolveCompiledScopes(ctx, identity, authenticated, options, true);
  }

  private async resolveCompiledScopes(
    ctx: object,
    identity: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    options: ResolveScopeOptions,
    native: boolean,
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
    const metadataCurrent = native ? accessMetadataGuard(this.db, [{ model, config }]) : undefined;
    const tenantPolicy = tenantBoundaryPolicy(collection);
    const requiredContextPaths = tenantPolicy
      ? tenantPolicy.mode === TENANT_INHERITED_MODE
        ? (['tenant.id', 'tenant.descendantIds'] as const)
        : (['tenant.id'] as const)
      : undefined;
    const context = await resolveAccessContext(
      this.db,
      config,
      { ...authenticated },
      { transaction, requiredContextPaths },
    );
    if (native && transaction) {
      const state = transaction as Transaction & { finished?: string; sequelize: Database['sequelize'] };
      if (state.finished || state.sequelize !== this.db.sequelize)
        throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Invalid authorization transaction after scope resolution');
    }
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
    metadataCurrent?.();
    if (!isDeepStrictEqual(tenantBoundaryPolicy(collection), tenantPolicy)) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Tenant collection policy changed during scope resolution');
    }
    if (tenantPolicy && typeof context['tenant.id'] !== 'string') {
      throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Tenant identity is unavailable for collection boundary');
    }
    const boundaries = tenantPolicy ? tenantBoundaries(tenantPolicy, context['tenant.id'] as string) : undefined;
    const metadata = resolveModelMetadata(collection, { resolveCollectionKey: this.resolveCollectionKey });
    const queryInterface = this.db.sequelize.getQueryInterface();
    return {
      config,
      scopes: compileAccessScopes(config, {
        collection: metadata,
        context,
        rootAlias,
        parameterPrefix,
        ...(boundaries ? { ownershipBoundary: boundaries.ownership, visibilityBoundary: boundaries.visibility } : {}),
        // The installed PostgreSQL ORM removes embedded quotes; native SQL must preserve physical names.
        quoteIdentifier: (name) => (native ? `"${name.replaceAll('"', '""')}"` : queryInterface.quoteIdentifier(name)),
        // Selected here by trusted server code, never forwarded from request/compiler options.
        ...(native
          ? {
              quoteValue: (value) =>
                String(
                  (queryInterface.queryGenerator as unknown as { escape(value: unknown): string | number }).escape(
                    value,
                  ),
                ),
            }
          : {}),
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
    const reserved = options.reservedBindNames ?? [];
    if (
      !Array.isArray(reserved) ||
      Object.getPrototypeOf(reserved) !== Array.prototype ||
      reserved.length > 10000 ||
      Reflect.ownKeys(reserved).length !== reserved.length + 1
    )
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Reserved bindings require a bounded dense list');
    for (let index = 0; index < reserved.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(reserved, index);
      const name: unknown = descriptor?.value;
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof name !== 'string' ||
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
      )
        throw new AccessRuleError('INVALID_ACCESS_RULE', 'Invalid reserved SQL binding name');
      keys.push(name);
    }
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
