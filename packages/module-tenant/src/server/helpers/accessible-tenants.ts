import type { Database } from '@tego/server';

import { buildPathPrefixFilter } from './tenant-tree';

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
  const descendantFilters: any[] = [];

  for (const tenant of directTenants) {
    const id = tenant.get('id') as string;
    const path = tenant.get('path') as string;

    accessibleIds.add(id);

    if (!path) {
      continue;
    }

    descendantFilters.push(buildPathPrefixFilter(path));
  }

  if (descendantFilters.length) {
    const descendants = await db.getRepository('tenants').find({
      filter: {
        $or: descendantFilters,
        enabled: true,
      },
      fields: ['id'],
      transaction: options.transaction,
    });

    descendants.forEach((descendant: any) => accessibleIds.add(descendant.get('id')));
  }

  return [...accessibleIds];
}
