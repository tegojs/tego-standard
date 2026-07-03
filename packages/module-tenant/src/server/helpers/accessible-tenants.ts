import type { Database } from '@tego/server';

import { getDescendantPathFilter, isTenantPathInSubtree } from './tenant-tree';

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
  const descendantSources: Array<{ id: string; path: string }> = [];

  for (const tenant of directTenants) {
    const id = tenant.get('id') as string;
    const path = tenant.get('path') as string;

    accessibleIds.add(id);

    if (!path) {
      continue;
    }

    descendantSources.push({ id, path });
  }

  if (descendantSources.length) {
    const descendants = await db.getRepository('tenants').find({
      filter: {
        $or: descendantSources.map(({ id, path }) => getDescendantPathFilter(path, id)),
        enabled: true,
      },
      fields: ['id', 'path'],
      transaction: options.transaction,
    });

    descendants.forEach((descendant: any) => {
      const path = descendant.get('path') as string;
      if (descendantSources.some((source) => isTenantPathInSubtree(path, source.path))) {
        accessibleIds.add(descendant.get('id'));
      }
    });
  }

  return [...accessibleIds];
}
