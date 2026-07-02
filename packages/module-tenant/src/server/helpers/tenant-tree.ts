import type { Repository } from '@tego/server';

export const TENANT_PATH_MAX_LENGTH = 500;

/**
 * Build the materialized path for a tenant node.
 */
export function buildPath(parentPath: string | null | undefined, id: string): string {
  const path = parentPath ? `${parentPath}${id}/` : `/${id}/`;

  if (path.length > TENANT_PATH_MAX_LENGTH) {
    throw new Error(`Tenant path exceeds maximum length of ${TENANT_PATH_MAX_LENGTH} characters`);
  }

  return path;
}

export function buildPathPrefixFilter(path: string) {
  return {
    path: {
      $gte: path,
      $lt: `${path}\uffff`,
    },
  };
}

async function getDescendantFilter(repo: Repository, tenantId: string, options: any = {}) {
  const tenant = await repo.findOne({
    filter: { id: tenantId },
    fields: ['id', 'path', 'parentId'],
    transaction: options.transaction,
  });

  const path = tenant?.get('path') as string;
  if (!path) {
    return null;
  }

  return {
    ...buildPathPrefixFilter(path),
    'id.$ne': tenantId,
    enabled: true,
  };
}

/**
 * Get all descendant tenant IDs for a given tenant using the materialized path.
 */
export async function getDescendantIds(repo: Repository, tenantId: string, options: any = {}): Promise<string[]> {
  const filter = await getDescendantFilter(repo, tenantId, options);
  if (!filter) {
    return [];
  }

  const descendants = await repo.find({
    filter,
    fields: ['id'],
    transaction: options.transaction,
  });
  return descendants.map((t: any) => t.get('id'));
}

/**
 * Get all descendant tenant records for a given tenant using the materialized path.
 */
export async function getDescendantTenants(repo: Repository, tenantId: string, options: any = {}): Promise<any[]> {
  const filter = await getDescendantFilter(repo, tenantId, options);
  if (!filter) {
    return [];
  }

  return repo.find({
    filter,
    transaction: options.transaction,
  });
}

export function getDescendantPathFilter(path: string, tenantId: string) {
  return {
    ...buildPathPrefixFilter(path),
    'id.$ne': tenantId,
  };
}

/**
 * Check whether assigning `newParentId` as the parent of `tenantId` would create a cycle.
 * A cycle occurs if the new parent's path is a descendant of the tenant's current path.
 */
export async function wouldCreateCycle(
  repo: Repository,
  tenantId: string,
  newParentId: string,
  options: any = {},
): Promise<boolean> {
  if (tenantId === newParentId) {
    return true;
  }

  const tenant = await repo.findOne({
    filter: { id: tenantId },
    fields: ['path'],
    transaction: options.transaction,
  });

  if (!tenant) {
    return false;
  }

  const currentPath = tenant.get('path') as string;
  let newParent = await repo.findOne({
    filter: { id: newParentId },
    fields: ['id', 'path', 'parentId'],
    transaction: options.transaction,
  });

  if (!newParent) {
    return false;
  }

  const parentPath = newParent.get('path') as string;
  if (currentPath && parentPath && parentPath.startsWith(currentPath)) {
    return true;
  }

  const visitedTenantIds = new Set<string>();
  while (newParent) {
    const currentParentId = newParent.get('id') as string;
    if (currentParentId === tenantId) {
      return true;
    }

    if (visitedTenantIds.has(currentParentId)) {
      return true;
    }
    visitedTenantIds.add(currentParentId);

    const parentId = newParent.get('parentId') as string | null;
    if (!parentId) {
      return false;
    }

    newParent = await repo.findOne({
      filter: { id: parentId },
      fields: ['id', 'parentId'],
      transaction: options.transaction,
    });
  }

  return false;
}

/**
 * Check if a manager tenant can manage a target tenant.
 * True when the target's path starts with the manager's path (i.e. target is self or descendant).
 */
export function canManageTenant(managerTenantPath: string, targetTenantPath: string): boolean {
  return targetTenantPath.startsWith(managerTenantPath);
}
