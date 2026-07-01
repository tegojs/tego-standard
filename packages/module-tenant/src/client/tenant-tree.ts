export type TenantRecord = {
  id: string;
  name: string;
  title?: string;
  enabled?: boolean;
  parentId?: string | null;
  path?: string;
  children?: TenantRecord[];
};

export function buildTenantTree(tenants: TenantRecord[]) {
  const records = new Map<string, TenantRecord>();
  const roots: TenantRecord[] = [];

  tenants.forEach((tenant) => {
    const { children: _children, ...rest } = tenant;
    records.set(tenant.id, { ...rest });
  });

  records.forEach((tenant) => {
    if (tenant.parentId && records.has(tenant.parentId)) {
      const parent = records.get(tenant.parentId)!;
      parent.children = parent.children || [];
      parent.children.push(tenant);
      return;
    }

    roots.push(tenant);
  });

  return roots;
}

export function getTenantParentOptions(tenants: TenantRecord[], editingTenant?: TenantRecord | null) {
  const editingPath = editingTenant?.path;
  const descendantPathPrefix = editingPath?.endsWith('/') ? editingPath : editingPath ? `${editingPath}/` : undefined;
  const excludedIds = new Set<string>();

  if (editingTenant?.id) {
    excludedIds.add(editingTenant.id);

    let changed = true;
    while (changed) {
      changed = false;

      tenants.forEach((tenant) => {
        if (tenant.parentId && excludedIds.has(tenant.parentId) && !excludedIds.has(tenant.id)) {
          excludedIds.add(tenant.id);
          changed = true;
        }
      });
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
