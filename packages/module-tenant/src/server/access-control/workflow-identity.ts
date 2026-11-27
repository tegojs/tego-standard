import type { AccessIdentity } from './context';
import { normalizeAccessContextValue } from './context-values';
import { AccessRuleError } from './types';
import { plain } from './write-support';

function data(input: Record<PropertyKey, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value'))
    throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Workflow execution identity cannot contain accessors');
  return descriptor.value;
}

/** Internal workflow identity projection, not an authentication entry. */
export function captureWorkflowAccessIdentity(context: unknown): Readonly<AccessIdentity> {
  if (!plain(context)) throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Workflow execution context is unavailable');
  const state = data(context, 'state');
  if (!plain(state)) throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Workflow execution state is unavailable');
  const identity: AccessIdentity = {};
  // Only canonical execution fields; currentUser/currentTenant may still describe a transient caller.
  for (const [field, key, path] of [
    ['currentTenantId', 'tenantId', 'tenant.id'],
    ['currentUserId', 'userId', 'user.id'],
    ['currentRole', 'roleName', 'role.name'],
  ] as const) {
    const value = data(state, field);
    if (value !== undefined && value !== null) identity[key] = normalizeAccessContextValue(path, value) as string;
  }
  return Object.freeze(identity);
}
