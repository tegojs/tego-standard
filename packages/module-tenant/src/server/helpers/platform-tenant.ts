import { TENANT_IMPERSONATION_SNIPPET } from '../../constants';
import { PLATFORM_ROOT_ROLE } from '../constants';

function getRoleName(role: any) {
  return typeof role === 'string' ? role : role?.name;
}

function getSnippetValues(snippets: any): string[] {
  if (Array.isArray(snippets)) {
    return snippets;
  }

  if (snippets instanceof Set) {
    return Array.from(snippets);
  }

  return [];
}

function hasSnippet(snippets: any, snippet: string) {
  const values = getSnippetValues(snippets);
  const denied = values.filter((item) => item.startsWith('!')).map((item) => item.slice(1));
  if (denied.includes(snippet)) {
    return false;
  }

  return values.includes(snippet);
}

function canRoleImpersonateTenant(role: any) {
  if (getRoleName(role) === PLATFORM_ROOT_ROLE) {
    return true;
  }

  return hasSnippet(role?.snippets, TENANT_IMPERSONATION_SNIPPET);
}

export function isPlatformTenantImpersonatorState(state: Record<string, any> = {}) {
  const roles = state.currentUser?.roles || [];
  if (state.currentRole) {
    if (state.currentRole === PLATFORM_ROOT_ROLE) {
      return true;
    }

    return roles.some((role: any) => getRoleName(role) === state.currentRole && canRoleImpersonateTenant(role));
  }

  return roles.some(canRoleImpersonateTenant);
}

export function isPlatformTenantImpersonatorContext(ctx: { state?: Record<string, any> }) {
  return isPlatformTenantImpersonatorState(ctx.state);
}
