import { PLATFORM_ROOT_ROLE } from '../constants';

export function isPlatformTenantImpersonatorState(state: Record<string, any> = {}) {
  const roles = state.currentUser?.roles || [];
  return roles.some((role: any) => (typeof role === 'string' ? role : role?.name) === PLATFORM_ROOT_ROLE);
}

export function isPlatformTenantImpersonatorContext(ctx: { state?: Record<string, any> }) {
  return isPlatformTenantImpersonatorState(ctx.state);
}
