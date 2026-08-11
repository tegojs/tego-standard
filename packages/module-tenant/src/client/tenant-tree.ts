export type TenantRecord = {
  id: string;
  name: string;
  title?: string;
  enabled?: boolean;
  parentId?: string | null;
  path?: string;
  children?: TenantRecord[];
};

const MAX_TENANT_RECORD_PAGES = 1000;

/**
 * Loads tenant records page by page for management screens that need the whole tree.
 */
export async function loadTenantRecords(api: any, isCanceled: () => boolean, pageSize = 200): Promise<TenantRecord[]> {
  const records: TenantRecord[] = [];
  let page = 1;

  while (!isCanceled() && page <= MAX_TENANT_RECORD_PAGES) {
    const res = await api.resource('tenants').list({ page, pageSize });
    const tenants = res?.data?.data || [];
    records.push(...tenants);

    if (tenants.length < pageSize) {
      break;
    }

    page += 1;
  }

  return records;
}

function buildChildrenByParent(tenants: Iterable<TenantRecord>) {
  const childrenByParent = new Map<string, TenantRecord[]>();

  for (const tenant of tenants) {
    if (!tenant.parentId) {
      continue;
    }

    const children = childrenByParent.get(tenant.parentId) || [];
    children.push(tenant);
    childrenByParent.set(tenant.parentId, children);
  }

  return childrenByParent;
}

/**
 * Converts a flat tenant list into a tree while ignoring cyclic parent relationships.
 */
export function buildTenantTree(tenants: TenantRecord[]) {
  const records = new Map<string, TenantRecord>();
  const roots: TenantRecord[] = [];
  const cycleRecords = new Set<string>();
  const safeRecords = new Set<string>();

  tenants.forEach((tenant) => {
    const { children: _children, ...rest } = tenant;
    records.set(tenant.id, { ...rest });
  });

  const hasCycle = (tenant: TenantRecord) => {
    if (safeRecords.has(tenant.id)) {
      return false;
    }
    if (cycleRecords.has(tenant.id)) {
      return true;
    }

    const visited = new Map<string, number>();
    const chain: string[] = [];
    let current: TenantRecord | undefined = tenant;

    while (current?.parentId && records.has(current.parentId)) {
      if (safeRecords.has(current.id)) {
        chain.forEach((id) => safeRecords.add(id));
        return false;
      }
      if (cycleRecords.has(current.id)) {
        chain.forEach((id) => cycleRecords.add(id));
        return true;
      }
      if (visited.has(current.id)) {
        chain.forEach((id) => cycleRecords.add(id));
        return true;
      }
      visited.set(current.id, chain.length);
      chain.push(current.id);
      current = records.get(current.parentId);
    }

    chain.forEach((id) => safeRecords.add(id));
    return false;
  };

  records.forEach((tenant) => {
    if (tenant.parentId && records.has(tenant.parentId) && !hasCycle(tenant)) {
      const parent = records.get(tenant.parentId)!;
      parent.children = parent.children || [];
      parent.children.push(tenant);
      return;
    }

    roots.push(tenant);
  });

  return roots;
}

/**
 * Builds valid parent options and excludes the edited tenant and its descendants.
 */
export function getTenantParentOptions(tenants: TenantRecord[], editingTenant?: TenantRecord | null) {
  const editingPath = editingTenant?.path;
  const descendantPathPrefix = editingPath?.endsWith('/') ? editingPath : editingPath ? `${editingPath}/` : undefined;
  const excludedIds = new Set<string>();
  const childrenByParent = buildChildrenByParent(tenants);

  if (editingTenant?.id) {
    excludedIds.add(editingTenant.id);
    const queue = [editingTenant.id];

    while (queue.length) {
      const parentId = queue.shift()!;
      for (const child of childrenByParent.get(parentId) || []) {
        if (excludedIds.has(child.id)) {
          continue;
        }

        excludedIds.add(child.id);
        queue.push(child.id);
      }
    }
  }

  return tenants
    .filter((tenant) => {
      if (!editingTenant?.id) {
        return true;
      }

      if (excludedIds.has(tenant.id)) {
        return false;
      }

      return !descendantPathPrefix || !tenant.path?.startsWith(descendantPathPrefix);
    })
    .map((tenant) => ({
      label: tenant.title || tenant.name || tenant.id,
      value: tenant.id,
    }));
}
