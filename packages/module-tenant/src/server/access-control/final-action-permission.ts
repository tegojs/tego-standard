import { cloneDeep, invalid, plain } from './write-support';

export interface AccessActionPermissionBinding {
  readonly resourceName: string;
  readonly actionName: string;
  readonly roleName: string;
}

export interface AccessFinalActionPermission {
  allowed: boolean;
  params: unknown;
}

function data(input: Record<PropertyKey, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Final action permission cannot contain accessors');
  return descriptor.value;
}

/**
 * Call only after the complete ACL middleware chain, with server context and binding.
 * Neither the decision nor its binding may come from request values or merged action params.
 * Entry adapters still enforce fields, resolved role conditions and ownership/visibility scopes.
 */
export function captureFinalActionPermission(
  permission: unknown,
  binding: AccessActionPermissionBinding,
): Readonly<AccessFinalActionPermission> {
  if (!plain(permission) || !plain(binding)) invalid('Final action permission context is unavailable');
  for (const key of ['resourceName', 'actionName', 'roleName']) {
    const value = data(binding, key);
    if (typeof value !== 'string' || !value.length || value.length > 255 || value.includes('\0'))
      invalid('Final action permission binding is invalid');
  }
  if (
    data(permission, 'resourceName') !== binding.resourceName ||
    data(permission, 'actionName') !== binding.actionName
  )
    invalid('Final action permission does not match the requested operation');
  const can = data(permission, 'can');
  const skip = data(permission, 'skip');
  if (skip !== undefined && typeof skip !== 'boolean') invalid('Final action permission skip must be explicit');
  if (can !== undefined && can !== null && can !== false) {
    if (
      !plain(can) ||
      data(can, 'resource') !== binding.resourceName ||
      data(can, 'action') !== binding.actionName ||
      data(can, 'role') !== binding.roleName
    )
      invalid('Final action permission decision does not match its binding');
  } else if (skip !== true) return Object.freeze({ allowed: false, params: {} });
  const params = data(permission, 'parsedParams');
  if (!plain(params)) invalid('Action permission parameters have not been finalized');
  return Object.freeze({ allowed: true, params: cloneDeep(params) });
}
