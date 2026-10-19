import type { AccessEntryReadPermission } from './read-grants';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessReadPermissionBinding {
  readonly resourceName: string;
  readonly actionName: string;
  readonly roleName: string;
}

function data(input: Record<PropertyKey, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Final read permission cannot contain accessors');
  return descriptor.value;
}

/**
 * Internal only: call inside the authorized handler after the complete ACL middleware chain.
 * The permission and binding must come from server context, never request values or merged action params.
 * Collection identity, field grants, resolved conditions and G/V are still checked by the read service.
 */
export function captureFinalReadPermission(
  permission: unknown,
  binding: AccessReadPermissionBinding,
): Readonly<AccessEntryReadPermission> {
  if (!plain(permission) || !plain(binding)) invalid('Final read permission context is unavailable');
  for (const key of ['resourceName', 'actionName', 'roleName']) {
    const value = data(binding, key);
    if (typeof value !== 'string' || !value.length || value.length > 255 || value.includes('\0'))
      invalid('Final read permission binding is invalid');
  }
  if (
    data(permission, 'resourceName') !== binding.resourceName ||
    data(permission, 'actionName') !== binding.actionName
  )
    invalid('Final read permission does not match the requested operation');
  const can = data(permission, 'can');
  const skip = data(permission, 'skip');
  if (skip !== undefined && typeof skip !== 'boolean') invalid('Final read permission skip must be explicit');
  if (can !== undefined && can !== null && can !== false) {
    if (
      !plain(can) ||
      data(can, 'resource') !== binding.resourceName ||
      data(can, 'action') !== binding.actionName ||
      data(can, 'role') !== binding.roleName
    )
      invalid('Final read permission decision does not match its binding');
  } else if (skip !== true) return Object.freeze({ allowed: false, params: {} });

  const params = data(permission, 'parsedParams');
  if (!plain(params)) invalid('Read permission parameters have not been finalized');
  return Object.freeze({ allowed: true, params: cloneDeep(params) });
}
