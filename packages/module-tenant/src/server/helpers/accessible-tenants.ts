import type { Database } from '@tego/server';

import { isTenantPathInSubtree } from './tenant-tree';

export async function getAccessibleTenantIds(db: Database, tenantIds: string[], options: { transaction?: any } = {}) {
  if (!tenantIds.length) {
    return [];
  }

  const directTenants = await db.getRepository('tenants').find({
    filter: {
      id: {
        $in: tenantIds,
      },
      enabled: true,
    },
    fields: ['id', 'path'],
    transaction: options.transaction,
  });

  const accessibleIds = new Set<string>();
  const accessiblePaths: string[] = [];

  for (const tenant of directTenants) {
    const id = tenant.get('id') as string;
    const path = tenant.get('path') as string;

    accessibleIds.add(id);

    if (!path) {
      continue;
    }

    accessiblePaths.push(path);
  }

  if (accessiblePaths.length) {
    const descendants = await db.getRepository('tenants').find({
      filter: {
        enabled: true,
      },
      fields: ['id', 'path'],
      transaction: options.transaction,
    });

    descendants.forEach((descendant: any) => {
      const path = descendant.get('path') as string;
      if (accessiblePaths.some((prefix) => isTenantPathInSubtree(path, prefix))) {
        accessibleIds.add(descendant.get('id'));
      }
    });
  }

  return [...accessibleIds];
}
