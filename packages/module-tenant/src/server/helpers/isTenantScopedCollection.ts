import { Collection } from '@tego/server';

export function isTenantScopedCollection(collection?: Collection | null) {
  if (!collection) {
    return false;
  }

  return collection.options?.tenancy === 'tenantScoped';
}

export function isTenantInheritedCollection(collection?: Collection | null) {
  if (!collection) {
    return false;
  }

  return collection.options?.tenancy === 'tenantInherited';
}

export function getCollectionTenancyMode(collection?: Collection | null): string | null {
  if (!collection) {
    return null;
  }

  return collection.options?.tenancy || null;
}

export default isTenantScopedCollection;
