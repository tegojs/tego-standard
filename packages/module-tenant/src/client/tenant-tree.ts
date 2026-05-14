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

  return tenants
    .filter((tenant) => {
      if (!editingTenant?.id) {
        return true;
      }

      if (tenant.id === editingTenant.id) {
        return false;
      }

      return !editingPath || !tenant.path?.startsWith(editingPath);
    })
    .map((tenant) => ({
      label: tenant.title || tenant.name || tenant.id,
      value: tenant.id,
    }));
}
