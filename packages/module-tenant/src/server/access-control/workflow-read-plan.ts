import type { Collection, Database } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessEntryReadOperation } from './entry-reads';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessReadDateContext } from './read-date-filter';
import { collectRelatedReadPaths } from './read-paths';
import type { AccessResourceListRequest } from './resource-read-params';
import { resolveResourceReadRoute } from './resource-read-routing';
import { invalid } from './write-support';

/** Metadata only. The caller must separately verify the original live list operation before using this plan. */
export function captureWorkflowReadPlan(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  operation: AccessEntryReadOperation,
  request: AccessResourceListRequest,
  dates?: AccessReadDateContext,
) {
  if (operation.kind !== 'list') invalid('Workflow read planning requires a list operation');
  const { limit: _limit, offset: _offset, ...selection } = request;
  const paths = collectRelatedReadPaths(db, resolveIdentity, operation, selection, dates);
  const root = db.getCollection(operation.source.collectionName);
  if (!root) invalid('Workflow read source is unavailable');
  const metadata = accessMetadataGuard(
    db,
    [],
    [[], ...paths].map((path) => ({
      model: root.model,
      path: path.at(-1) === '$through' ? path.slice(0, -1) : path,
    })),
  );
  const bindings = new Map<
    string,
    {
      collection: Collection;
      assertCurrent(): void;
    }
  >();
  const sources = new Map<string, Readonly<AccessCollectionIdentity>>();
  for (const path of [[], ...paths]) {
    let collection = root;
    let relation: (typeof root.model.associations)[string] & { through?: { model?: Collection['model'] } };
    for (const [index, part] of path.entries()) {
      if (part === '$through') {
        const through = relation?.through?.model;
        if (index !== path.length - 1 || !through) invalid('Workflow read through path is unavailable');
        collection = db.modelCollection.get(through)!;
      } else {
        relation = collection.model.associations[part];
        collection = relation && db.modelCollection.get(relation.target);
      }
      if (!collection) invalid('Workflow read path target is unavailable');
    }
    const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName: collection.name, actionName: 'list' });
    if (route.identity.dataSourceKey !== operation.source.dataSourceKey)
      invalid('Workflow read paths cannot cross data sources');
    const key = accessCollectionKey(route.identity);
    if (!path.length && key !== accessCollectionKey(operation.source))
      invalid('Workflow read source identity does not match the operation');
    if (sources.has(key) && sources.get(key)!.collectionName !== route.identity.collectionName)
      invalid('Workflow read tables cannot share a persistent identity');
    bindings.set(JSON.stringify(path), { collection, assertCurrent: route.assertCurrent });
    sources.set(key, route.identity);
  }
  const assertCurrent = () => {
    metadata();
    for (const binding of bindings.values()) binding.assertCurrent();
  };
  assertCurrent();
  return {
    sources: Object.freeze([...sources.values()]),
    assertCurrent,
    matches(collection: Collection, path: readonly string[]) {
      const binding = bindings.get(JSON.stringify(path));
      if (!binding || binding.collection !== collection) return false;
      binding.assertCurrent();
      return true;
    },
  };
}
