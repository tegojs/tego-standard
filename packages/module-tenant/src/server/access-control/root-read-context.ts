import type { Collection, Database } from '@tego/server';

import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalReadPermission } from './final-read-permission';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import { parseResourceCountParams, parseResourceGetParams, parseResourceListParams } from './resource-read-params';
import { resolveResourceReadRoute } from './resource-read-routing';
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
function captureParams(
  permission: unknown,
  resourceName: string,
  actionName: 'list' | 'get' | 'count',
  association?: { source: string; relation: string },
) {
  if (!plain(permission)) invalid('Root read permission context is unavailable');
  const raw = data(permission, 'rawParams');
  if (!plain(raw)) invalid('Root reads require the original action parameters');
  // Preserve original array prototypes until the strict request parsers have validated them.
  const params: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(raw));
  for (const key of Reflect.ownKeys(raw))
    Object.defineProperty(params, key, { value: data(raw, key), writable: true, enumerable: true, configurable: true });
  for (const [key, expected] of [
    ['resourceName', association?.relation ?? resourceName],
    ['actionName', actionName],
    ['associatedName', association?.source],
    ['associatedIndex', association ? '_' : undefined],
  ] as const) {
    if (Object.hasOwn(params, key) && params[key] !== expected)
      invalid('Root read transport metadata does not match the requested operation');
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
  return captureReadContext(ctx, authenticated, action, dates);
}

function captureReadContext(
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  action: { resourceName: string; actionName: 'list' | 'get' | 'count' },
  dates?: AccessReadDateContext,
  association?: { source: string; relation: string },
) {
  if (!plain(authenticated)) invalid('Root read authenticated identity is unavailable');
  const identity = Object.freeze(cloneDeep<AccessIdentity>(authenticated));
  const roleName = identity.roleName;
  if (typeof roleName !== 'string') invalid('Root reads require an authenticated role');
  const permission = captureFinalReadPermission(ctx.permission, { ...action, roleName });
  const params = captureParams(ctx.permission, action.resourceName, action.actionName, association);
  const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
  return { action, identity, roleName, permission, params, dateContext };
}

/** Core /_/ resolves a target repository, not a concrete source record. */
export function capturePlaceholderReadContext(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  dates?: AccessReadDateContext,
) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object')
    invalid('Placeholder read does not match the resource database');
  const resourceName = data(ctx.action, 'resourceName');
  const actionName = data(ctx.action, 'actionName');
  const resourceOf = data(ctx.action, 'resourceOf');
  if (
    typeof resourceName !== 'string' ||
    resourceName.split('.').length !== 2 ||
    typeof actionName !== 'string' ||
    !['get', 'list'].includes(actionName) ||
    data(ctx.action, 'sourceId') !== '_' ||
    (resourceOf !== undefined && resourceOf !== '_')
  )
    invalid('Placeholder reads require an association get/list action without a concrete source');
  const [source, relation] = resourceName.split('.');
  if (!plain(ctx.permission)) invalid('Placeholder target permission is unavailable');
  const targetName = data(ctx.permission, 'resourceName');
  if (typeof targetName !== 'string') invalid('Placeholder reads require a target collection decision');
  const captured = captureReadContext(
    ctx,
    authenticated,
    { resourceName: targetName, actionName: actionName as 'get' | 'list' },
    dates,
    { source, relation },
  );
  const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName, actionName, sourceId: '_' });
  if (route.kind !== 'direct' || route.identity.collectionName !== targetName)
    invalid('Placeholder permission does not match its actual target collection');
  route.assertCurrent();
  return { captured, assertCurrent: route.assertCurrent };
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
