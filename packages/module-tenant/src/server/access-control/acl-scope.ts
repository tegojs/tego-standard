import { isDeepStrictEqual } from 'node:util';
import { getRoleActionScope, type RoleActionScope } from '@tachybase/module-acl';
import type { ACL, ACLRole, Database } from '@tego/server';

import { canDelegateBuiltinTenantScope, readBuiltinTenantScopeId } from './builtin-tenant-scope';
import { AccessConfigError } from './config-errors';
import type { AccessCollectionIdentity, AccessConfigStore } from './config-store';
import type { AccessConfig } from './types';

type ActionParams = ReturnType<ACLRole['getActionParams']>;

export interface AccessRoleScopeSelection {
  role: string;
  action: string;
}

/** Scope treatment only, not an effective ACL decision or permission to migrate. */
export interface AccessRoleScopePreview {
  dataSourceKey: string;
  role: string;
  resource: string;
  action: string;
  treatment: 'delegate-builtin-scope' | 'retain-role-scope' | 'no-direct-resource-grant';
  params?: ActionParams;
  scope?: RoleActionScope;
}

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
        ? await readBuiltinTenantScopeId(this.db, this.dataSourceKey)
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

  /** Read-only administrator tooling. It does not prepare a phase, register a resolver or save rules. */
  async previewRoleScope(roleName: string, resource: string, action: string): Promise<AccessRoleScopePreview> {
    return (await this.captureRoleScopes(resource, [{ role: roleName, action }]).read())[0];
  }

  /** Capture a bounded explicit selection together. This is an inspection snapshot, never an authorization lease. */
  captureRoleScopes(resource: string, selections: readonly AccessRoleScopeSelection[]) {
    const validName = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 255;
    const invalid = (): never => {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid role scope inspection identity');
    };
    if (
      !validName(resource) ||
      !Array.isArray(selections) ||
      Object.getPrototypeOf(selections) !== Array.prototype ||
      selections.length > 1000 ||
      Reflect.ownKeys(selections).length !== selections.length + 1
    )
      invalid();
    const entries = Array.from({ length: selections.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(selections, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
      const entry: unknown = descriptor!.value;
      if (
        !entry ||
        typeof entry !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(entry)) ||
        Reflect.ownKeys(entry).length !== 2
      )
        return invalid();
      const fields = Object.getOwnPropertyDescriptors(entry);
      if (
        !['role', 'action'].every(
          (name) =>
            Object.hasOwn(fields, name) && Object.hasOwn(fields[name], 'value') && validName(fields[name].value),
        )
      )
        return invalid();
      const roleName: string = fields.role.value;
      const action: string = fields.action.value;
      const role = this.acl.getRole(roleName);
      const directParams = () => {
        const current = role?.getResource(resource);
        return current?.actions.get(current.actions.has(action) ? action : this.acl.resolveActionAlias(action));
      };
      const original = directParams();
      const params = structuredClone(original);
      const scope = getRoleActionScope(role, resource, action);
      return { roleName, action, role, directParams, original, params, scope };
    });
    const assertCurrent = () => {
      for (const entry of entries) {
        if (
          this.acl.getRole(entry.roleName) !== entry.role ||
          entry.directParams() !== entry.original ||
          !isDeepStrictEqual(entry.original, entry.params) ||
          !isDeepStrictEqual(getRoleActionScope(entry.role, resource, entry.action), entry.scope)
        )
          throw new AccessConfigError(
            'ACCESS_CONFIG_CONFLICT',
            'Role scope changed; reload the migration preview',
            409,
          );
      }
    };
    return {
      assertCurrent,
      read: async (): Promise<AccessRoleScopePreview[]> => {
        assertCurrent();
        const builtinScopeId = entries.some((entry) => entry.original)
          ? await readBuiltinTenantScopeId(this.db, this.dataSourceKey)
          : undefined;
        assertCurrent();
        return entries.map(({ roleName, action, original, params, scope }) => ({
          dataSourceKey: this.dataSourceKey,
          role: roleName,
          resource,
          action,
          treatment: !original
            ? 'no-direct-resource-grant'
            : canDelegateBuiltinTenantScope(this.dataSourceKey, builtinScopeId, scope, params!)
              ? 'delegate-builtin-scope'
              : 'retain-role-scope',
          ...(original ? { params: structuredClone(params), scope: structuredClone(scope) } : {}),
        }));
      },
    };
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
    if (!canDelegateBuiltinTenantScope(this.dataSourceKey, phase.builtinScopeId, scope, params)) return params;
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
