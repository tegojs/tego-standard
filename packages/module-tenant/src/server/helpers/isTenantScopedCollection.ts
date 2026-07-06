import { Collection } from '@tego/server';

import { TENANT_INHERITED_MODE, TENANT_SCOPED_MODE } from '../constants';

export function isTenantScopedCollection(collection?: Collection | null) {
  return getCollectionTenancyMode(collection) === TENANT_SCOPED_MODE;
}

export function isTenantInheritedCollection(collection?: Collection | null) {
  return getCollectionTenancyMode(collection) === TENANT_INHERITED_MODE;
}

export function getCollectionTenancyMode(collection?: Collection | null): string | null {
  if (!collection) {
    return null;
  }

  return collection.options?.tenancy || null;
}

export default isTenantScopedCollection;
