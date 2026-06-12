export function buildAttachmentUploadHeaders(formHeaders: Record<string, any>, token: string, repositoryContext?: any) {
  const tenantId = repositoryContext?.state?.currentTenant?.id ?? repositoryContext?.state?.currentTenantId;

  return {
    ...formHeaders,
    Authorization: 'Bearer ' + token,
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  };
}
