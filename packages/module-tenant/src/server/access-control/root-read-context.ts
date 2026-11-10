import { captureExportXlsxRequest } from '@tachybase/plugin-action-export';
import type { Collection, Database } from '@tego/server';

import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalReadPermission } from './final-read-permission';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import {
  parseResourceAssociationGetParams,
  parseResourceCountParams,
  parseResourceExportParams,
  parseResourceListParams,
  parseResourceSumParams,
} from './resource-read-params';
import { resolveResourceReadRoute } from './resource-read-routing';
import { captureRootTextSearch } from './root-text-search';
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
    !['list', 'get', 'count', 'sum', 'export'].includes(actionName) ||
    data(ctx.action, 'sourceId') !== undefined ||
    data(ctx.action, 'resourceOf') !== undefined
  )
    invalid('Unsupported root read action');
  return { resourceName, actionName: actionName as 'list' | 'get' | 'count' | 'sum' | 'export' };
}

/** Strip only verified core transport metadata, never arbitrary client options. */
function captureParams(
  permission: unknown,
  resourceName: string,
  actionName: 'list' | 'get' | 'count' | 'sum' | 'export',
  association?: { source: string; relation: string; index: string | number },
  single = false,
  searchContext?: { collection: Collection; permission: { allowed: boolean; params: unknown } },
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
    ['associatedIndex', association?.index],
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
  if (Object.hasOwn(params, 'search') && actionName === 'list' && !association && searchContext) {
    params.filter = captureRootTextSearch(
      searchContext.collection,
      searchContext.permission,
      params.search,
      params.filter,
    );
    delete params.search;
  }
  if (actionName === 'list') {
    if (association && (params.paginate === false || params.paginate === 'false'))
      invalid('Complete association resource lists require a dedicated adapter');
    parseResourceListParams(params);
  } else if (actionName === 'export') parseResourceExportParams(params);
  else if (actionName === 'get') parseResourceAssociationGetParams(params, single);
  else if (actionName === 'sum') parseResourceSumParams(params);
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
  action: { resourceName: string; actionName: 'list' | 'get' | 'count' | 'sum' | 'export' },
  dates?: AccessReadDateContext,
  association?: { source: string; relation: string; index: string | number },
  single = false,
) {
  const authorization = captureReadAuthorization(ctx, authenticated, action);
  const params = captureParams(ctx.permission, action.resourceName, action.actionName, association, single, {
    collection: ctx.db.getCollection(action.resourceName),
    permission: authorization.permission,
  });
  const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
  return { action, ...authorization, params, dateContext };
}

function captureReadAuthorization(
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  action: { resourceName: string; actionName: string },
) {
  if (!plain(authenticated)) invalid('Root read authenticated identity is unavailable');
  const identity = Object.freeze(cloneDeep<AccessIdentity>(authenticated));
  const roleName = identity.roleName;
  if (typeof roleName !== 'string') invalid('Root reads require an authenticated role');
  const permission = captureFinalReadPermission(ctx.permission, { ...action, roleName });
  return { identity, roleName, permission };
}

/** File presentation is captured separately; authorization still belongs to this original request phase. */
export function captureExportReadContext(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  dates?: AccessReadDateContext,
) {
  const placeholder =
    ctx.action && typeof ctx.action === 'object' && data(ctx.action, 'sourceId') === '_'
      ? capturePlaceholderAction(db, ctx, ['export'])
      : undefined;
  const concrete =
    !placeholder &&
    ctx.action &&
    typeof ctx.action === 'object' &&
    typeof data(ctx.action, 'resourceName') === 'string' &&
    (data(ctx.action, 'resourceName') as string).includes('.')
      ? captureAssociationAction(db, ctx, ['export'])
      : undefined;
  const action = placeholder?.action ?? concrete?.targetAction ?? captureAction(ctx, db);
  if (action.actionName !== 'export') invalid('File exports require an export action');
  const authorization = captureReadAuthorization(ctx, authenticated, action);
  const file = captureExportXlsxRequest(data(ctx.permission as object, 'rawParams'));
  const params = captureParams(
    { rawParams: file.params },
    action.resourceName,
    'export',
    placeholder?.association ?? concrete?.association,
  );
  const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
  const captured = { action, ...authorization, params, dateContext };
  const association = concrete && captureAssociationRoute(db, resolveIdentity, concrete, captured);
  const assertCurrent = placeholder && capturePlaceholderRoute(db, resolveIdentity, placeholder);
  return {
    captured,
    columns: file.columns,
    title: file.title,
    assertCurrent,
    association,
  };
}

function capturePlaceholderAction(
  db: Database,
  ctx: AccessRootReadContext,
  actions: readonly ('get' | 'list' | 'export')[],
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
    !actions.includes(actionName as 'get' | 'list' | 'export') ||
    data(ctx.action, 'sourceId') !== '_' ||
    (resourceOf !== undefined && resourceOf !== '_')
  )
    invalid('Unsupported placeholder read action or source');
  const [source, relation] = resourceName.split('.');
  if (!plain(ctx.permission)) invalid('Placeholder target permission is unavailable');
  const targetName = data(ctx.permission, 'resourceName');
  if (typeof targetName !== 'string') invalid('Placeholder reads require a target collection decision');
  return {
    action: { resourceName: targetName, actionName: actionName as 'get' | 'list' | 'export' },
    descriptor: { resourceName, actionName, sourceId: '_' },
    association: { source, relation, index: '_' },
  };
}

function capturePlaceholderRoute(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  placeholder: ReturnType<typeof capturePlaceholderAction>,
) {
  const route = resolveResourceReadRoute(db, resolveIdentity, placeholder.descriptor);
  if (route.kind !== 'direct' || route.identity.collectionName !== placeholder.action.resourceName)
    invalid('Placeholder permission does not match its actual target collection');
  route.assertCurrent();
  return route.assertCurrent;
}

/** Core /_/ resolves a target repository, not a concrete source record. */
export function capturePlaceholderReadContext(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  dates?: AccessReadDateContext,
) {
  const placeholder = capturePlaceholderAction(db, ctx, ['get', 'list']);
  const captured = captureReadContext(ctx, authenticated, placeholder.action, dates, placeholder.association);
  return { captured, assertCurrent: capturePlaceholderRoute(db, resolveIdentity, placeholder) };
}

/** A concrete association's final ACL decision belongs to the target, never to its source. */
export function captureAssociationReadContext(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  dates?: AccessReadDateContext,
) {
  const descriptor = captureAssociationAction(db, ctx, ['get', 'list', 'count']);
  const captured = captureReadContext(ctx, authenticated, descriptor.targetAction, dates, descriptor.association, true);
  return captureAssociationRoute(db, resolveIdentity, descriptor, captured);
}

function captureAssociationAction(
  db: Database,
  ctx: AccessRootReadContext,
  actions: readonly ('get' | 'list' | 'count' | 'export')[],
) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object')
    invalid('Association read does not match the resource database');
  const resourceName = data(ctx.action, 'resourceName');
  const actionName = data(ctx.action, 'actionName');
  const sourceId = data(ctx.action, 'sourceId');
  const resourceOf = data(ctx.action, 'resourceOf');
  if (
    typeof resourceName !== 'string' ||
    resourceName.length > 511 ||
    resourceName.split('.').length !== 2 ||
    typeof actionName !== 'string' ||
    !actions.includes(actionName as 'get' | 'list' | 'count' | 'export') ||
    sourceId === '_' ||
    !(
      (typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 512) ||
      (typeof sourceId === 'number' && Number.isSafeInteger(sourceId))
    ) ||
    (resourceOf !== undefined && resourceOf !== sourceId)
  )
    invalid('Association reads require a concrete source and a supported action');
  if (!plain(ctx.permission)) invalid('Association target permission is unavailable');
  const targetName = data(ctx.permission, 'resourceName');
  if (typeof targetName !== 'string') invalid('Association reads require a target collection decision');
  const [source, relation] = resourceName.split('.');
  const action = { resourceName, actionName, sourceId };
  return {
    action,
    targetAction: { resourceName: targetName, actionName: actionName as 'get' | 'list' | 'count' | 'export' },
    association: { source, relation, index: sourceId },
  };
}

function captureAssociationRoute(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  descriptor: ReturnType<typeof captureAssociationAction>,
  captured: ReturnType<typeof captureReadContext>,
) {
  const {
    action,
    association: { source, relation },
    targetAction: { resourceName: targetName },
  } = descriptor;
  const { resourceName, actionName } = action;
  const route = resolveResourceReadRoute(db, resolveIdentity, action);
  const target = resolveResourceReadRoute(db, resolveIdentity, { resourceName, actionName: 'get', sourceId: '_' });
  if (route.kind !== 'association' || target.identity.collectionName !== targetName)
    invalid('Association permission does not match its actual target collection');
  const sourceCollection = db.getCollection(source);
  const targetCollection = db.getCollection(targetName);
  const single = ['HasOne', 'BelongsTo'].includes(sourceCollection.model.associations[relation].associationType);
  if (actionName === 'get') parseResourceAssociationGetParams(captured.params, single);
  const assertCurrent = () => {
    route.assertCurrent();
    target.assertCurrent();
  };
  assertCurrent();
  return { captured, action, identity: route.identity, sourceCollection, targetCollection, relation, assertCurrent };
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
