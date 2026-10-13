import { isDeepStrictEqual } from 'node:util';
import type { ACLRole, Model } from '@tego/server';

/** Server-only source of a persisted role scope; never stored in action parameters. */
export interface RoleActionScope {
  scopeCollection: string;
  scopeId: unknown;
  key: unknown;
  dataSourceKey: unknown;
  resourceName: unknown;
  filter: unknown;
}

interface ScopeGrant {
  params: object;
  scope: RoleActionScope;
}

const grants = new WeakMap<ACLRole, Map<string, Map<string, ScopeGrant>>>();

/** Capture before grant hooks can modify the filter object. */
export function snapshotRoleActionScope(scope: Model | null): RoleActionScope | undefined {
  if (!scope) return;
  return structuredClone({
    scopeCollection: (scope.constructor as typeof Model).collection.name,
    scopeId: scope.get('id'),
    key: scope.get('key'),
    dataSourceKey: scope.get('dataSourceKey'),
    resourceName: scope.get('resourceName'),
    filter: scope.get('scope'),
  });
}

/** Only the persistent role-action writer registers provenance. */
export function recordRoleActionScope(
  role: ACLRole,
  resource: string,
  action: string,
  scope: RoleActionScope | undefined,
) {
  if (!scope) {
    grants.get(role)?.get(resource)?.delete(action);
    return;
  }
  let resources = grants.get(role);
  if (!resources) grants.set(role, (resources = new Map()));
  let actions = resources.get(resource);
  if (!actions) resources.set(resource, (actions = new Map()));
  actions.delete(action);
  const params = role.getResource(resource)?.actions.get(action);
  if (params && isDeepStrictEqual(params.filter, scope.filter)) {
    actions.set(action, { params, scope });
  }
}

/** Revoked, re-granted or changed filters have no trusted source. */
export function getRoleActionScope(role: ACLRole, resource: string, action: string): RoleActionScope | undefined {
  if (!role) return;
  const current = role.getResource(resource);
  const resolved = current?.actions.has(action) ? action : role.acl.resolveActionAlias(action);
  const grant = grants.get(role)?.get(resource)?.get(resolved);
  const params = current?.actions.get(resolved);
  if (!grant || grant.params !== params || !isDeepStrictEqual(params.filter, grant.scope.filter)) return;
  return structuredClone(grant.scope);
}
