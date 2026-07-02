export function isPlatformTenantImpersonatorState(state: Record<string, any> = {}) {
  const roles = state.currentUser?.roles || [];
  return roles.some((role: any) => (typeof role === 'string' ? role : role?.name) === 'root');
}

export function isPlatformTenantImpersonatorContext(ctx: { state?: Record<string, any> }) {
  return isPlatformTenantImpersonatorState(ctx.state);
}
