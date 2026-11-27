import type { Collection, Database, Transaction } from '@tego/server';

import { parseChartQueryParams } from './chart-query-params';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureFinalActionPermission } from './final-action-permission';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import type { AccessRelatedReadAuthorizer } from './related-read-contexts';
import type { AccessRootReadContext } from './root-read-context';
import type { AccessRootReadHandler } from './root-read-handler';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessChartAuthorizers {
  /** A separate neutral collection list decision, after the full existing ACL chain. */
  source: (collection: Collection) => Promise<AccessRootReadContext | null>;
  related: AccessRelatedReadAuthorizer;
}

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Chart entry cannot contain accessors');
  return descriptor.value;
}

/** Internal charts:query adapter; no routes, cache or business activation are registered here. */
export class AccessChartQueryHandler {
  constructor(
    private readonly db: Database,
    private readonly reader: AccessRootReadHandler,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async handle(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorize: AccessChartAuthorizers,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object')
      invalid('Chart entry does not match the resource database');
    if (
      data(ctx.action, 'resourceName') !== 'charts' ||
      data(ctx.action, 'actionName') !== 'query' ||
      data(ctx.action, 'sourceId') !== undefined ||
      data(ctx.action, 'resourceOf') !== undefined ||
      !plain(authenticated)
    )
      invalid('Chart entry requires an authenticated charts:query operation');
    const actor = Object.freeze(cloneDeep(authenticated));
    if (typeof actor.roleName !== 'string') invalid('Chart entry requires an authenticated role');
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName: 'charts',
      actionName: 'query',
      roleName: actor.roleName,
    });
    if (!permission.allowed) invalid('Chart operation is not authorized');
    // Chart-resource constraints cannot silently disappear when authorizing the selected collection.
    if (
      !plain(permission.params) ||
      Reflect.ownKeys(permission.params).some((key) => {
        const value = data(permission.params as object, key);
        if (key === 'own') return value !== false;
        if (key === 'filter') return !plain(value) || Reflect.ownKeys(value).length !== 0;
        return !['fields', 'appends'].includes(String(key)) || !Array.isArray(value) || value.length !== 0;
      })
    )
      invalid('Unsupported chart operation permission constraints');
    if (!plain(ctx.permission)) invalid('Chart permission is unavailable');
    const raw = data(ctx.permission, 'rawParams');
    if (!plain(raw)) invalid('Chart entry requires original action parameters');
    const transport: Record<string, unknown> = { resourceName: 'charts', actionName: 'query', filterByTk: undefined };
    for (const key of Reflect.ownKeys(raw)) {
      if (key === 'values') continue;
      if (typeof key !== 'string' || !Object.hasOwn(transport, key) || data(raw, key) !== transport[key])
        invalid('Unsupported chart entry parameters');
    }
    const values = data(raw, 'values');
    const request = parseChartQueryParams(values);
    const input = cloneDeep(values);
    const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
    const collection = this.db.collections.get(request.collection);
    if (!collection || collection.db !== this.db) invalid('Chart collection is unavailable');
    const model = collection.model;
    const resolved = this.resolveIdentity(collection);
    if (!resolved || resolved.collectionName !== request.collection || resolved.dataSourceKey !== request.dataSource)
      invalid('Chart collection identity does not match the requested data source');
    const identity = cloneDeep(resolved);
    const assertCurrent = () => {
      const current = this.resolveIdentity(collection);
      if (
        this.db.collections.get(request.collection) !== collection ||
        collection.model !== model ||
        !current ||
        current.collectionName !== identity.collectionName ||
        accessCollectionKey(current) !== accessCollectionKey(identity)
      )
        invalid('Chart collection identity changed during authorization');
    };
    assertCurrent();
    const source = await authorize.source(collection);
    assertCurrent();
    if (!source) invalid('Chart entry requires an authorized collection context');
    await this.reader.handleChartWithRelatedContexts(source, actor, input, authorize.related, transaction, dateContext);
    assertCurrent();
    ctx.body = source.body;
  }
}
