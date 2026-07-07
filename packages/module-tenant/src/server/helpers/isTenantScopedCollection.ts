import { Collection } from '@tego/server';

import { TENANT_INHERITED_MODE, TENANT_SCOPED_MODE } from '../constants';

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
export function getCollectionTenancyMode(collection?: Collection | null): string | null {
  if (!collection) {
    return null;
  }

  return collection.options?.tenancy || null;
}

export default isTenantScopedCollection;
