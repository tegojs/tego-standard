import { Collection } from '@tego/server';

import { TENANT_ENABLED_MODES, TENANT_INHERITED_MODE, TENANT_SCOPED_MODE } from '../constants';

export type TenantEnabledMode = (typeof TENANT_ENABLED_MODES)[number];

/**
 * Provides the is tenant scoped collection helper for this module.
 */
export function isTenantScopedCollection(collection?: Collection | null) {
  return getCollectionTenancyMode(collection) === TENANT_SCOPED_MODE;
}

/**
 * Provides the is tenant inherited collection helper for this module.
 */
export function isTenantInheritedCollection(collection?: Collection | null) {
  return getCollectionTenancyMode(collection) === TENANT_INHERITED_MODE;
}

/**
 * Provides the get collection tenancy mode helper for this module.
 */
export function getCollectionTenancyMode(collection?: Collection | null): TenantEnabledMode | null {
  if (!collection) {
    return null;
  }

  const tenancyMode = collection.options?.tenancy;
  return TENANT_ENABLED_MODES.includes(tenancyMode as TenantEnabledMode) ? (tenancyMode as TenantEnabledMode) : null;
}
