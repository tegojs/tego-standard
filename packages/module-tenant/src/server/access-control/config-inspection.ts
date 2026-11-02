import { isDeepStrictEqual } from 'node:util';
import type { Application, Collection } from '@tego/server';

import { AccessConfigError } from './config-errors';
import { accessCollectionKey, AccessConfigStore, type AccessConfigRevisionPage } from './config-store';
import { accessMetadataGuard } from './metadata-snapshot';
import { resolveModelMetadata } from './model-metadata';
import { AccessMutationError } from './mutation-errors';
import { validateAccessConfig } from './validate';

export type AccessConfigRevisionInspection =
  | { type: 'list'; limit?: number; beforeRevision?: number }
  | { type: 'draft'; revision: number };

/** Shared read-only inspection. The caller must authenticate and snapshot its request first. */
export async function inspectAccessConfig(
  app: Application,
  { dataSourceKey, collectionName }: { dataSourceKey: string; collectionName: string },
  candidate?: unknown,
  revisionRequest?: AccessConfigRevisionInspection,
) {
  const primaryDb = app.db;
  const manager = app.dataSourceManager;
  const source = dataSourceKey === 'main' ? undefined : manager.dataSources.get(dataSourceKey);
  const collectionManager = source?.collectionManager;
  const db = dataSourceKey === 'main' ? primaryDb : collectionManager?.db;
  if (!db) throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Data source is unavailable', 404);
  const conflict = (): never => {
    throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Access configuration metadata changed', 409);
  };
  const assertSource = () => {
    if (
      app.db !== primaryDb ||
      (dataSourceKey !== 'main' &&
        (app.dataSourceManager !== manager ||
          manager.dataSources.get(dataSourceKey) !== source ||
          source?.collectionManager !== collectionManager ||
          collectionManager?.db !== db))
    )
      conflict();
  };
  const metadata = primaryDb.getCollection(dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections');
  const records = await metadata?.model.findAll({
    where: { name: collectionName, ...(dataSourceKey === 'main' ? {} : { dataSourceKey }) },
    limit: 2,
    useMaster: true,
    transaction: null,
  });
  assertSource();
  if (records?.length !== 1)
    throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Collection metadata is unavailable', 404);
  const identity = { dataSourceKey, collectionName, collectionKey: records[0].get('key') as string };
  accessCollectionKey(identity);
  const collection = db.getCollection(collectionName);
  if (!collection || collection.db !== db || collection.options.key !== identity.collectionKey) conflict();
  const model = collection.model;
  const resolveCollectionKey = (target: Collection) => {
    if (target.db !== db || db.getCollection(target.name) !== target) conflict();
    return accessCollectionKey({ dataSourceKey, collectionName: target.name, collectionKey: target.options.key });
  };
  const resolveMetadata = () => {
    assertSource();
    if (
      db.getCollection(collectionName) !== collection ||
      collection.model !== model ||
      collection.options.key !== identity.collectionKey
    )
      conflict();
    return resolveModelMetadata(collection, { resolveCollectionKey });
  };
  const store = new AccessConfigStore(primaryDb, resolveMetadata);
  const config = await store.read(identity);
  assertSource();
  let validatedConfig = candidate === undefined ? undefined : validateAccessConfig(candidate, resolveMetadata());
  let revisionPage: AccessConfigRevisionPage | undefined;
  let sourceRevision: number | undefined;
  if (revisionRequest?.type === 'list')
    revisionPage = await store.listRevisions(identity, revisionRequest.limit, revisionRequest.beforeRevision);
  if (revisionRequest?.type === 'draft') {
    const draft = await store.revisionDraft(identity, revisionRequest.revision);
    sourceRevision = draft.sourceRevision;
    validatedConfig = validateAccessConfig(draft.config, resolveMetadata());
  }
  if (validatedConfig && validatedConfig.revision !== (config?.revision ?? 0)) conflict();
  const assertMetadata = accessMetadataGuard(db, [
    { model, config: config ?? { schemaVersion: 1, revision: 0, ownership: { enabled: false }, rules: [] } },
    ...(validatedConfig
      ? [
          {
            model,
            // Validation includes disabled rules; snapshot their dependencies as well.
            config: { ...validatedConfig, rules: validatedConfig.rules.map((rule) => ({ ...rule, enabled: true })) },
          },
        ]
      : []),
  ]);
  const latest = await store.read(identity);
  assertSource();
  try {
    assertMetadata();
  } catch (error) {
    if (error instanceof AccessMutationError && error.code === 'INVALID_ACCESS_MUTATION') conflict();
    throw error;
  }
  if (!isDeepStrictEqual(config, latest)) conflict();
  return { identity, config, validatedConfig, revisionPage, sourceRevision };
}
