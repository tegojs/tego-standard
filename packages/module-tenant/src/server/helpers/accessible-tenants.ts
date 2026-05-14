import type { Database } from '@tego/server';

export async function getAccessibleTenantIds(db: Database, tenantIds: string[]) {
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
  });

  const accessibleIds = new Set<string>();

  for (const tenant of directTenants) {
    const id = tenant.get('id') as string;
    const path = tenant.get('path') as string;

    accessibleIds.add(id);

    if (!path) {
      continue;
    }

    const descendants = await db.getRepository('tenants').find({
      filter: {
        path: {
          $like: `${path}%`,
        },
        enabled: true,
      },
      fields: ['id'],
    });

    descendants.forEach((descendant: any) => accessibleIds.add(descendant.get('id')));
  }

  return [...accessibleIds];
}
