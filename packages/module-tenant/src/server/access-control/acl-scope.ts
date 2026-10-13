import { isDeepStrictEqual } from 'node:util';
import { getRoleActionScope } from '@tachybase/module-acl';
import type { ACL, ACLRole, Database } from '@tego/server';

import { AccessConfigError } from './config-errors';
import type { AccessCollectionIdentity, AccessConfigStore } from './config-store';
import type { AccessConfig } from './types';

type ActionParams = ReturnType<ACLRole['getActionParams']>;

/** Structural contract while standard still depends on the previous core release. */
export interface AccessActionParamsContext {
  acl: ACL;
  role: string;
  resource: string;
  action: string;
  rawResourceName?: string;
  source: 'resource' | 'strategy';
  ctx?: object;
}

type ResolvingAcl = ACL & {
  registerActionParamsResolver?: (
    resolver: (context: AccessActionParamsContext, params: ActionParams) => ActionParams,
  ) => () => void;
};

interface RequestPhase {
  configs?: Map<string, { identity: AccessCollectionIdentity; config: AccessConfig | null }>;
  builtinScopeId?: unknown;
}

/**
 * Internal ACL adapter only. It delegates the old role scope; it does not enforce G/V.
 * Runtime registration requires the complete tenant query/write adapters at every entry.
 */
export class AccessAclScopeAdapter {
  private requests = new WeakMap<object, RequestPhase>();
  private unregister?: () => void;

  constructor(
    private readonly acl: ACL,
    private readonly dataSourceKey: string,
    private readonly store: AccessConfigStore,
    private readonly db: Database,
  ) {}

  /** One authenticated server request/execution phase; values are never taken from ctx fields. */
  async prepare(ctx: object, identities: readonly AccessCollectionIdentity[]): Promise<void> {
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid access request context');
    }
    if (this.requests.has(ctx)) {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Access request context is already prepared');
    }
    const phase: RequestPhase = {};
    this.requests.set(ctx, phase);
    try {
      const snapshot = this.store.snapshot();
      const configs: NonNullable<RequestPhase['configs']> = new Map();
      for (const source of identities) {
        const identity = {
          dataSourceKey: source.dataSourceKey,
          collectionKey: source.collectionKey,
          collectionName: source.collectionName,
        };
        if (identity.dataSourceKey !== this.dataSourceKey || configs.has(identity.collectionName)) {
          throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Ambiguous access collection data source');
        }
        configs.set(identity.collectionName, { identity, config: await snapshot.read(identity) });
      }
      const builtinScopeId = [...configs.values()].some(({ config }) => config)
        ? await this.builtinScopeId()
        : undefined;
      if (this.requests.get(ctx) !== phase) {
        throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Access request phase has ended');
      }
      phase.builtinScopeId = builtinScopeId;
      phase.configs = configs;
    } catch (error) {
      if (this.requests.get(ctx) === phase) this.requests.delete(ctx);
      throw error;
    }
  }

  release(ctx: object): void {
    this.requests.delete(ctx);
  }

  private async builtinScopeId(): Promise<unknown> {
    if (this.dataSourceKey !== 'main') return;
    const collection = this.db.getCollection('dataSourcesRolesResourcesScopes');
    if (!collection) return;
    // The scope key is not unique. Ambiguity must preserve the original ACL restriction.
    const scopes = await collection.model.findAll({
      where: { dataSourceKey: 'main', key: 'tenant' },
      limit: 2,
      useMaster: true,
    });
    if (scopes.length !== 1) return;
    const scope = scopes[0];
    const resourceName = scope.get('resourceName');
    if (
      (resourceName !== undefined && resourceName !== null && resourceName !== '') ||
      !isDeepStrictEqual(scope.get('scope'), { tenantId: '{{ ctx.state.currentTenant.id }}' })
    )
      return;
    return scope.get('id');
  }

  /** The query adapter must compile this same snapshot, never re-read configuration mid-phase. */
  configuration(ctx: object, identity: AccessCollectionIdentity): AccessConfig | null {
    const entry = this.requests.get(ctx)?.configs?.get(identity.collectionName);
    if (
      !entry ||
      identity.dataSourceKey !== this.dataSourceKey ||
      entry.identity.collectionKey !== identity.collectionKey ||
      entry.identity.dataSourceKey !== identity.dataSourceKey
    ) {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Access request collection identity is not prepared');
    }
    return entry.config;
  }

  /** Called by core before any fixed or request filters are merged. */
  readonly resolve = (context: AccessActionParamsContext, params: ActionParams): ActionParams => {
    if (context.acl !== this.acl || context.source !== 'resource' || !context.ctx) return params;
    const phase = this.requests.get(context.ctx);
    const config = phase?.configs?.get(context.resource)?.config;
    if (!config) return params;
    const scope = getRoleActionScope(this.acl.getRole(context.role), context.resource, context.action);
    // Only the global, unchanged scope created by ensureTenantAclScope is a built-in template.
    if (
      !scope ||
      phase.builtinScopeId === undefined ||
      !isDeepStrictEqual(scope.scopeId, phase.builtinScopeId) ||
      this.dataSourceKey !== 'main' ||
      scope.scopeCollection !== 'dataSourcesRolesResourcesScopes' ||
      scope.dataSourceKey !== this.dataSourceKey ||
      scope.key !== 'tenant' ||
      (scope.resourceName !== undefined && scope.resourceName !== null && scope.resourceName !== '') ||
      !isDeepStrictEqual(scope.filter, { tenantId: '{{ ctx.state.currentTenant.id }}' }) ||
      !isDeepStrictEqual(params.filter, scope.filter)
    )
      return params;
    const delegated = { ...params };
    delete delegated.filter;
    return delegated;
  };

  /** Explicit only: no plugin entry installs this adapter yet. */
  register(): () => void {
    const acl = this.acl as ResolvingAcl;
    if (typeof acl.registerActionParamsResolver !== 'function') {
      throw new AccessConfigError(
        'INVALID_ACCESS_CONFIG_WRITE',
        'Core does not support the ACL action parameters resolver',
      );
    }
    if (this.unregister) {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'ACL access adapter is already registered');
    }
    const unregister = acl.registerActionParamsResolver(this.resolve);
    this.unregister = unregister;
    return () => {
      if (this.unregister !== unregister) return;
      unregister();
      this.unregister = undefined;
      this.requests = new WeakMap();
    };
  }
}
