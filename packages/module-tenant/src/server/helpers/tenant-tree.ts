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

/**
 * Get all descendant tenant IDs for a given tenant using the materialized path.
 */
export async function getDescendantIds(repo: Repository, tenantId: string): Promise<string[]> {
  const tenant = await repo.findOne({
    filter: { id: tenantId },
    fields: ['path'],
  });

  const path = tenant?.get('path') as string;
  if (!path) {
    return [];
  }

  const descendants = await repo.find({
    filter: {
      path: { $like: `${path}%` },
      'id.$ne': tenantId,
    },
    fields: ['id'],
  });
  return descendants.map((t: any) => t.get('id'));
}

/**
 * Check whether assigning `newParentId` as the parent of `tenantId` would create a cycle.
 * A cycle occurs if the new parent's path is a descendant of the tenant's current path.
 */
export async function wouldCreateCycle(repo: Repository, tenantId: string, newParentId: string): Promise<boolean> {
  if (tenantId === newParentId) {
    return true;
  }

  const tenant = await repo.findOne({
    filter: { id: tenantId },
    fields: ['path'],
  });

  if (!tenant) {
    return false;
  }

  const currentPath = tenant.get('path') as string;
  const newParent = await repo.findOne({
    filter: { id: newParentId },
    fields: ['path'],
  });

  if (!newParent) {
    return false;
  }

  const parentPath = newParent.get('path') as string;
  return parentPath.startsWith(currentPath);
}

/**
 * Check if a manager tenant can manage a target tenant.
 * True when the target's path starts with the manager's path (i.e. target is self or descendant).
 */
export function canManageTenant(managerTenantPath: string, targetTenantPath: string): boolean {
  return targetTenantPath.startsWith(managerTenantPath);
}
