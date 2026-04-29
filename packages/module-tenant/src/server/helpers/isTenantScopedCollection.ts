import { Collection } from '@tego/server';

export function isTenantScopedCollection(collection?: Collection | null) {
  if (!collection) {
    return false;
  }

  return collection.options?.tenancy === 'tenantScoped';
}

export default isTenantScopedCollection;
