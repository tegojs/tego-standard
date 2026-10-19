import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessEntryReadService, type AccessEntryReadOperation } from './entry-reads';
import { captureFinalReadPermission } from './final-read-permission';
import type { AccessQueryService } from './query';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessRootReadContext {
  db: Database;
  action: object;
  permission: unknown;
  body?: unknown;
  paginate?: boolean;
}

/** Server-finalized, unfiltered target list context for this exact request/path; never client input. */
export type AccessRelatedReadContextResolver = (
  collection: Collection,
  path: readonly string[],
  operation: AccessEntryReadOperation,
) => AccessRootReadContext | null;

function data(input: object, key: string): unknown {
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
  return { resourceName, actionName };
}

/** Strip only verified core transport metadata, never arbitrary client options. */
function captureParams(permission: unknown, resourceName: string, actionName: string) {
  if (!plain(permission)) invalid('Root read permission context is unavailable');
  const raw = data(permission, 'rawParams');
  if (!plain(raw)) invalid('Root reads require the original action parameters');
  const params = cloneDeep(raw);
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
  return params;
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

/**
 * Internal handler for prepared root list/get/count actions after the complete core ACL chain.
 * No routes are registered here. The caller supplies authenticated identity and date context.
 */
export class AccessRootReadHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly resolveRelatedContext?: AccessRelatedReadContextResolver,
  ) {}

  async handle(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    const { resourceName, actionName } = captureAction(ctx, this.db);
    if (!plain(authenticated)) invalid('Root read authenticated identity is unavailable');
    const identity = Object.freeze(cloneDeep<AccessIdentity>(authenticated));
    const roleName = identity.roleName;
    if (typeof roleName !== 'string') invalid('Root reads require an authenticated role');
    const permission = captureFinalReadPermission(ctx.permission, {
      resourceName,
      actionName,
      roleName,
    });
    const params = captureParams(ctx.permission, resourceName, actionName);
    const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
    const reads = new AccessEntryReadService(
      this.db,
      this.prepared,
      this.queries,
      this.resolveIdentity,
      (collection, path, operation) => {
        if (path.length === 0) return permission;
        const related = this.resolveRelatedContext?.(collection, Object.freeze([...path]), operation);
        if (related == null) return null;
        return captureRelatedReadPermission(this.db, collection, roleName, related);
      },
    );
    const body = await reads.fromResource(
      ctx,
      identity,
      { resourceName, actionName },
      params,
      transaction,
      dateContext,
    );
    ctx.body = body;
    if (actionName === 'list') ctx.paginate = true;
  }
}
