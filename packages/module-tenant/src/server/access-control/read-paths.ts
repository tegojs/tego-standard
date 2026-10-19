import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessEntryReadOperation } from './entry-reads';
import { captureAccessFilter } from './filter-input';
import type { AccessQueryService } from './query';
import { captureReadDateContext, resolveReadDateFilter, type AccessReadDateContext } from './read-date-filter';
import { AccessReadSelectionParser } from './read-selection';
import { AccessRequestFilterParser, type AccessFilterReadGrant } from './request-filter';
import { parseResourceCountParams, parseResourceGetParams, parseResourceListParams } from './resource-read-params';
import { resolveResourceReadRoute } from './resource-read-routing';
import { AccessSortService } from './sort';
import { cloneDeep, invalid, plain } from './write-support';

/** Metadata-only planning for root reads. Private parser views never authorize or execute a query. */
export function collectRelatedReadPaths(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  operation: AccessEntryReadOperation,
  params: unknown,
  dates?: AccessReadDateContext,
): readonly (readonly string[])[] {
  if (
    !plain(operation) ||
    Reflect.ownKeys(operation).some(
      (key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(operation, key)!, 'value'),
    ) ||
    !['list', 'get', 'count'].includes(operation.kind) ||
    !operation.context ||
    typeof operation.context !== 'object' ||
    !plain(operation.source) ||
    !plain(operation.authenticated)
  )
    invalid('Read path planning requires a root read operation');
  // Snapshot all inputs before any trusted metadata callback is invoked.
  const captured = {
    kind: operation.kind,
    context: operation.context,
    source: cloneDeep(operation.source),
    authenticated: cloneDeep(operation.authenticated),
  };
  const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
  if (typeof captured.authenticated.roleName !== 'string' || !captured.authenticated.roleName.length)
    invalid('Read path planning requires an authenticated role');
  const request =
    captured.kind === 'list'
      ? parseResourceListParams(params)
      : captured.kind === 'get'
        ? parseResourceGetParams(params)
        : parseResourceCountParams(params);
  // The parsers capture lists without normalizing invalid prototypes; capture JSON before callbacks too.
  const filter = captureAccessFilter(request.filter === undefined ? {} : request.filter);
  const root = resolveResourceReadRoute(db, resolveIdentity, {
    resourceName: captured.source.collectionName,
    actionName: captured.kind,
  });
  if (!isDeepStrictEqual(root.identity, captured.source)) invalid('Read path source identity does not match');
  const nodes = new Map<
    string,
    {
      collection: Collection;
      path: readonly string[];
      view: AccessFilterReadGrant;
      assertCurrent(): void;
    }
  >();
  const add = (collection: Collection, path: readonly string[], route: ReturnType<typeof resolveResourceReadRoute>) => {
    if (path.length && nodes.size > 100) invalid('Read path planning exceeds the path limit');
    if (route.identity.dataSourceKey !== captured.source.dataSourceKey)
      invalid('Read path planning cannot cross data sources');
    const view: AccessFilterReadGrant = {
      identity: route.identity,
      fields: Object.freeze([
        ...Object.keys(collection.model.rawAttributes).filter(
          (name) => (collection.model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL',
        ),
        ...Object.keys(collection.model.associations),
      ]),
    };
    const node = { collection, path: Object.freeze([...path]), view, assertCurrent: route.assertCurrent };
    nodes.set(JSON.stringify(path), node);
    return node;
  };
  add(db.getCollection(root.identity.collectionName), [], root);
  const bind = (path: readonly string[]): ReturnType<typeof add> => {
    const previous = nodes.get(JSON.stringify(path));
    if (previous) {
      previous.assertCurrent();
      return previous;
    }
    const parent = bind(path.slice(0, -1));
    const name = path.at(-1)!;
    if (name === '$through') invalid('Read path through model is unavailable');
    const route = resolveResourceReadRoute(db, resolveIdentity, {
      resourceName: `${parent.collection.name}.${name}`,
      actionName: 'list',
      sourceId: '_',
    });
    const collection = db.getCollection(route.identity.collectionName);
    const node = add(collection, path, route);
    const relation = parent.collection.model.associations[name];
    if (relation.associationType === 'BelongsToMany') {
      const throughModel = (relation as typeof relation & { through?: { model?: Collection['model'] } }).through?.model;
      const through = throughModel && db.modelCollection.get(throughModel);
      if (!through) invalid('Read path through model is unavailable');
      const throughRoute = resolveResourceReadRoute(db, resolveIdentity, {
        resourceName: through.name,
        actionName: 'list',
      });
      add(through, [...path, '$through'], throughRoute);
    }
    return node;
  };
  const metadata = (collection: Collection, path: readonly string[]) => {
    const node = bind(path);
    if (node.collection !== collection) invalid('Read path does not match its registered collection');
    return node.view;
  };
  if (captured.kind !== 'count') {
    const selection = Object.fromEntries(
      ['fields', 'appends', 'except']
        .filter((key) => Object.hasOwn(request, key))
        .map((key) => [key, (request as Record<string, unknown>)[key]]),
    );
    new AccessReadSelectionParser(db, metadata).parse(nodes.get('[]')!.collection, selection);
  }
  new AccessRequestFilterParser(db, metadata).parse(
    captured.source,
    dateContext === undefined
      ? filter
      : resolveReadDateFilter(
          filter,
          dateContext,
          (path) => db.getFieldByPath(`${captured.source.collectionName}.${path.join('.')}`)?.timezone,
        ),
  );
  if (captured.kind === 'list' && 'sort' in request && request.sort !== undefined)
    new AccessSortService(db, prepared, queries, metadata).prepareRoots(
      captured.context,
      captured.source,
      captured.authenticated,
      { sort: request.sort },
    );
  for (const node of nodes.values()) node.assertCurrent();
  return Object.freeze([...nodes.values()].filter(({ path }) => path.length).map(({ path }) => path));
}
