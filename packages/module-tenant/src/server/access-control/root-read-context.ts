import type { Collection, Database } from '@tego/server';

import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalReadPermission } from './final-read-permission';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import { parseResourceCountParams, parseResourceGetParams, parseResourceListParams } from './resource-read-params';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessRootReadContext {
  db: Database;
  action: object;
  permission: unknown;
  body?: unknown;
  paginate?: boolean;
}

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Root read context cannot contain accessors');
  return descriptor.value;
}

function captureAction(ctx: AccessRootReadContext, db: Database) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object')
    invalid('Root read handler does not match the resource database');
  const resourceName = data(ctx.action, 'resourceName');
  const actionName = data(ctx.action, 'actionName');
  if (
    typeof resourceName !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resourceName) ||
    typeof actionName !== 'string' ||
    !['list', 'get', 'count'].includes(actionName) ||
    data(ctx.action, 'sourceId') !== undefined ||
    data(ctx.action, 'resourceOf') !== undefined
  )
    invalid('Unsupported root read action');
  return { resourceName, actionName: actionName as 'list' | 'get' | 'count' };
}

/** Strip only verified core transport metadata, never arbitrary client options. */
function captureParams(permission: unknown, resourceName: string, actionName: 'list' | 'get' | 'count') {
  if (!plain(permission)) invalid('Root read permission context is unavailable');
  const raw = data(permission, 'rawParams');
  if (!plain(raw)) invalid('Root reads require the original action parameters');
  // Preserve original array prototypes until the strict request parsers have validated them.
  const params: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(raw));
  for (const key of Reflect.ownKeys(raw))
    Object.defineProperty(params, key, { value: data(raw, key), writable: true, enumerable: true, configurable: true });
  for (const [key, expected] of [
    ['resourceName', resourceName],
    ['actionName', actionName],
  ] as const) {
    if (Object.hasOwn(params, key) && params[key] !== expected)
      invalid('Root read transport metadata does not match the requested operation');
    delete params[key];
  }
  for (const key of ['associatedName', 'associatedIndex']) {
    if (params[key] !== undefined) invalid('Association reads require a dedicated handler');
    delete params[key];
  }
  if (params.resourceIndex !== undefined) {
    const key = params.resourceIndex;
    if (
      actionName !== 'get' ||
      !(
        (typeof key === 'string' && key.length > 0 && key.length <= 512) ||
        (typeof key === 'number' && Number.isSafeInteger(key))
      ) ||
      !['string', 'number'].includes(typeof params.filterByTk) ||
      String(key) !== String(params.filterByTk)
    )
      invalid('Root read REST locator does not match its detail key');
  }
  delete params.resourceIndex;
  // Core sets this own undefined property even for lists and counts.
  if (params.filterByTk === undefined) delete params.filterByTk;
  if (actionName === 'list') parseResourceListParams(params);
  else if (actionName === 'get') parseResourceGetParams(params);
  else parseResourceCountParams(params);
  if (params.filter !== undefined) params.filter = captureAccessFilter(params.filter);
  return cloneDeep(params);
}

/** Snapshot the already-authorized root operation before metadata or asynchronous callbacks. */
export function captureRootReadContext(
  db: Database,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  dates?: AccessReadDateContext,
) {
  const action = captureAction(ctx, db);
  if (!plain(authenticated)) invalid('Root read authenticated identity is unavailable');
  const identity = Object.freeze(cloneDeep<AccessIdentity>(authenticated));
  const roleName = identity.roleName;
  if (typeof roleName !== 'string') invalid('Root reads require an authenticated role');
  const permission = captureFinalReadPermission(ctx.permission, { ...action, roleName });
  const params = captureParams(ctx.permission, action.resourceName, action.actionName);
  const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
  return { action, identity, roleName, permission, params, dateContext };
}

/** Capture only a neutral target list decision finalized by the existing server authorization chain. */
export function captureRelatedReadPermission(
  db: Database,
  collection: Collection,
  roleName: string,
  related: AccessRootReadContext,
) {
  const action = captureAction(related, db);
  if (action.resourceName !== collection.name || action.actionName !== 'list')
    invalid('Related reads require the target collection list decision');
  const granted = captureFinalReadPermission(related.permission, {
    resourceName: action.resourceName,
    actionName: 'list',
    roleName,
  });
  if (!granted.allowed) return granted;
  // A decision made for a filtered lookup cannot authorize arbitrary related rows.
  if (Reflect.ownKeys(captureParams(related.permission, action.resourceName, 'list')).length)
    invalid('Related read decisions require an unfiltered target list context');
  return granted;
}
