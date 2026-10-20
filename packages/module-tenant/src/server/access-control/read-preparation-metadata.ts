import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import { accessMetadataGuard } from './metadata-snapshot';
import { resolveResourceReadRoute } from './resource-read-routing';
import { invalid } from './write-support';

/** Bind only participating models, relationship paths and G/V dependencies before awaiting authorization. */
export function captureReadPreparationMetadata(
  db: Database,
  prepared: AccessAclScopeAdapter,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: object,
  source: Collection,
  paths: readonly (readonly string[])[],
) {
  const roots: Parameters<typeof accessMetadataGuard>[1] = [];
  const checks: Array<() => void> = [];
  const collections = new Set<Collection>();
  const captureCollection = (collection: Collection | undefined) => {
    if (!collection) invalid('Read preparation metadata collection is unavailable');
    if (collections.has(collection)) return;
    collections.add(collection);
    const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName: collection.name, actionName: 'list' });
    const config = prepared.configuration(ctx, route.identity);
    if (!config) invalid('Reads require prepared collection configurations');
    roots.push({ model: collection.model, config });
    checks.push(() => {
      route.assertCurrent();
      if (prepared.configuration(ctx, route.identity) !== config) invalid('Read preparation phase changed');
    });
  };
  captureCollection(source);
  for (const path of paths) {
    let collection = source;
    for (const part of path) {
      if (part === '$through') break;
      const association = collection.model.associations[part] as (typeof collection.model.associations)[string] & {
        through?: { model?: Collection['model'] };
      };
      if (!association) invalid('Read preparation metadata path is unavailable');
      const through = association.through;
      const throughModel = through?.model;
      checks.push(() => {
        if (association.through !== through || through?.model !== throughModel)
          invalid('Related preparation through model changed');
      });
      if (throughModel) captureCollection(db.modelCollection.get(throughModel));
      collection = db.modelCollection.get(association.target)!;
      captureCollection(collection);
    }
  }
  const metadata = accessMetadataGuard(
    db,
    roots,
    paths.map((path) => ({
      model: source.model,
      path: path.at(-1) === '$through' ? path.slice(0, -1) : path,
    })),
  );
  return () => {
    for (const check of checks) check();
    metadata();
  };
}
