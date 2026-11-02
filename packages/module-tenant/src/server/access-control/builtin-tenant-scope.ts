import { isDeepStrictEqual } from 'node:util';
import type { RoleActionScope } from '@tachybase/module-acl';
import type { Database } from '@tego/server';

const tenantFilter = Object.freeze({ tenantId: '{{ ctx.state.currentTenant.id }}' });

/** Authoritative identity only; a duplicate, modified or missing scope is never delegated. */
export async function readBuiltinTenantScopeId(db: Database, dataSourceKey: string): Promise<unknown> {
  if (dataSourceKey !== 'main') return;
  const collection = db.getCollection('dataSourcesRolesResourcesScopes');
  if (!collection) return;
  const scopes = await collection.model.findAll({
    where: { dataSourceKey: 'main', key: 'tenant' },
    limit: 2,
    useMaster: true,
    transaction: null,
  });
  if (scopes.length !== 1) return;
  const scope = scopes[0];
  const resourceName = scope.get('resourceName');
  if (
    (resourceName !== undefined && resourceName !== null && resourceName !== '') ||
    !isDeepStrictEqual(scope.get('scope'), tenantFilter)
  )
    return;
  return scope.get('id');
}

/** Shared by runtime delegation and administrative inspection; does not grant permission. */
export function canDelegateBuiltinTenantScope(
  dataSourceKey: string,
  builtinScopeId: unknown,
  scope: RoleActionScope | undefined,
  params: { filter?: unknown },
): boolean {
  return (
    !!scope &&
    builtinScopeId !== undefined &&
    isDeepStrictEqual(scope.scopeId, builtinScopeId) &&
    dataSourceKey === 'main' &&
    scope.scopeCollection === 'dataSourcesRolesResourcesScopes' &&
    scope.dataSourceKey === dataSourceKey &&
    scope.key === 'tenant' &&
    (scope.resourceName === undefined || scope.resourceName === null || scope.resourceName === '') &&
    isDeepStrictEqual(scope.filter, tenantFilter) &&
    isDeepStrictEqual(params.filter, scope.filter)
  );
}
