export function getAuditContext(options) {
  const state = options?.context?.state;
  const currentUserId = state?.currentUser?.id;

  return {
    userId: currentUserId,
    tenantId: state?.currentTenantId,
    actorUserId: state?.actorUserId || currentUserId,
    impersonatedTenantId: state?.impersonatedTenantId,
    tenantContextSource: state?.tenantContextSource,
    isTenantImpersonation: !!state?.isTenantImpersonation,
  };
}
