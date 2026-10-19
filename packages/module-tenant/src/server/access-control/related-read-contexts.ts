import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database } from '@tego/server';

import type { AccessCollectionIdentity } from './config-store';
import type { AccessEntryReadOperation } from './entry-reads';
import { resolveResourceReadRoute } from './resource-read-routing';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import type { AccessRelatedReadContextResolver } from './root-read-handler';
import { cloneDeep, invalid, plain } from './write-support';

export type AccessRelatedReadAuthorizer = (
  collection: Collection,
  path: readonly string[],
  operation: AccessEntryReadOperation,
) => Promise<AccessRootReadContext | null>;

interface RelatedPath {
  collection: Collection;
  path: readonly string[];
  through?: Collection;
  assertCurrent(): void;
}

function dense(input: unknown, maximum: number): input is unknown[] {
  return (
    Array.isArray(input) &&
    Object.getPrototypeOf(input) === Array.prototype &&
    input.length <= maximum &&
    Reflect.ownKeys(input).length === input.length + 1 &&
    Array.from({ length: input.length }, (_, index) => Object.hasOwn(input, index)).every(Boolean)
  );
}

function capturePaths(input: unknown): string[][] {
  const paths = cloneDeep(input);
  if (!dense(paths, 100)) invalid('Related preparation requires bounded association paths');
  return paths.map((path) => {
    if (!dense(path, 9) || !path.length) invalid('Related preparation requires bounded association paths');
    return path.map((part, index) => {
      if (
        typeof part !== 'string' ||
        (part !== '$through' &&
          (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) || ['_', '__proto__', 'constructor', 'prototype'].includes(part)))
      )
        invalid('Related preparation contains an invalid association name');
      if (part === '$through' && index !== path.length - 1) invalid('Through permissions must be terminal');
      return part;
    });
  });
}

/** Prepare explicit query-plan paths only; the caller runs its existing ACL chain, never a second evaluator. */
export async function prepareRelatedReadContexts(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  operation: AccessEntryReadOperation,
  paths: unknown,
  authorize: AccessRelatedReadAuthorizer,
): Promise<AccessRelatedReadContextResolver> {
  if (
    !plain(operation) ||
    !operation.context ||
    typeof operation.context !== 'object' ||
    !['list', 'get', 'count'].includes(operation.kind) ||
    !plain(operation.source) ||
    !plain(operation.authenticated)
  )
    invalid('Related preparation requires a root read operation');
  const captured: AccessEntryReadOperation = Object.freeze({
    kind: operation.kind,
    context: operation.context,
    source: Object.freeze(cloneDeep(operation.source)),
    authenticated: Object.freeze(cloneDeep(operation.authenticated)),
  });
  const roleName = captured.authenticated.roleName;
  if (typeof roleName !== 'string' || !roleName.length) invalid('Related preparation requires an authenticated role');
  const root = resolveResourceReadRoute(db, resolveIdentity, {
    resourceName: captured.source.collectionName,
    actionName: captured.kind,
  });
  if (!isDeepStrictEqual(root.identity, captured.source)) invalid('Related preparation source identity does not match');
  const nodes = new Map<string, RelatedPath>();
  nodes.set('[]', {
    collection: db.getCollection(root.identity.collectionName),
    path: Object.freeze([]),
    assertCurrent: root.assertCurrent,
  });
  // Resolve and bind every path synchronously before invoking an asynchronous authorizer.
  for (const path of capturePaths(paths)) {
    for (let index = 0; index < path.length; index++) {
      const part = path[index];
      const prefix = path.slice(0, index + 1);
      const key = JSON.stringify(prefix);
      if (nodes.has(key)) continue;
      if (nodes.size > 100) invalid('Related preparation exceeds the path limit');
      const parent = nodes.get(JSON.stringify(prefix.slice(0, -1)))!;
      let target: Collection;
      let through: Collection | undefined;
      let assertCurrent: () => void;
      if (part === '$through') {
        if (!parent.through) invalid('Through permissions require a registered many-to-many model');
        target = parent.through;
        assertCurrent = parent.assertCurrent;
      } else {
        const route = resolveResourceReadRoute(db, resolveIdentity, {
          resourceName: `${parent.collection.name}.${part}`,
          actionName: 'list',
          sourceId: '_',
        });
        target = db.getCollection(route.identity.collectionName);
        const relation = parent.collection.model.associations[part];
        const throughRelation = relation as typeof relation & { through?: { model?: Collection['model'] } };
        const throughOptions = throughRelation.through;
        const throughModel = throughOptions?.model;
        through = throughModel && db.modelCollection.get(throughModel);
        if (relation.associationType === 'BelongsToMany' && !through)
          invalid('Related preparation through model is unavailable');
        assertCurrent = () => {
          parent.assertCurrent();
          route.assertCurrent();
          if (
            throughRelation.through !== throughOptions ||
            throughOptions?.model !== throughModel ||
            (throughModel && db.modelCollection.get(throughModel) !== through)
          )
            invalid('Related preparation through model changed');
        };
      }
      const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName: target.name, actionName: 'list' });
      if (route.identity.dataSourceKey !== captured.source.dataSourceKey)
        invalid('Related preparation cannot cross data sources');
      const assertRelation = assertCurrent;
      nodes.set(key, {
        collection: target,
        path: Object.freeze(prefix),
        through,
        assertCurrent: () => {
          assertRelation();
          route.assertCurrent();
        },
      });
    }
  }
  const assertCurrent = () => {
    for (const node of nodes.values()) node.assertCurrent();
  };
  const contexts = new Map<string, AccessRootReadContext | null>();
  for (const [key, node] of nodes) {
    if (key === '[]') continue;
    assertCurrent();
    const context = await authorize(node.collection, node.path, captured);
    const permission = context == null ? null : captureRelatedReadPermission(db, node.collection, roleName, context);
    assertCurrent();
    if (!permission) {
      contexts.set(key, null);
      continue;
    }
    // Persist only the validated final decision, not the mutable source context or raw ACL metadata.
    contexts.set(key, {
      db,
      action: Object.freeze({ resourceName: node.collection.name, actionName: 'list' }),
      permission: {
        resourceName: node.collection.name,
        actionName: 'list',
        can: permission.allowed ? { resource: node.collection.name, action: 'list', role: roleName } : false,
        parsedParams: permission.params,
        rawParams: {},
      },
    });
  }
  assertCurrent();
  return (collection, path, current) => {
    if (
      current.context !== captured.context ||
      current.kind !== captured.kind ||
      !isDeepStrictEqual(current.source, captured.source) ||
      !isDeepStrictEqual(current.authenticated, captured.authenticated)
    )
      invalid('Prepared related permissions belong to another read operation');
    assertCurrent();
    const key = JSON.stringify(path);
    const context = contexts.get(key);
    if (!context) return null;
    if (nodes.get(key)?.collection !== collection) invalid('Prepared related permission target does not match');
    return { ...context, permission: cloneDeep(context.permission) };
  };
}
