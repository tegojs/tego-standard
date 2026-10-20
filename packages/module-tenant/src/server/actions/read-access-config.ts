import { isDeepStrictEqual } from 'node:util';
import type { Application, Collection, Context, Next } from '@tego/server';

import { AccessConfigError } from '../access-control/config-errors';
import { accessCollectionKey, AccessConfigStore } from '../access-control/config-store';
import { accessMetadataGuard } from '../access-control/metadata-snapshot';
import { resolveModelMetadata } from '../access-control/model-metadata';
import { AccessMutationError } from '../access-control/mutation-errors';
import { AccessRuleError } from '../access-control/types';
import { translateTenantError } from '../locale';

function selection(input: unknown) {
  const invalid = (): never => {
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid access configuration selection');
  };
  if (
    !input ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 2
  )
    return invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    !['dataSourceKey', 'collectionName'].every(
      (name) =>
        Object.hasOwn(fields, name) &&
        Object.hasOwn(fields[name], 'value') &&
        typeof fields[name].value === 'string' &&
        fields[name].value.length > 0 &&
        fields[name].value.length <= 255,
    )
  )
    return invalid();
  return { dataSourceKey: fields.dataSourceKey.value as string, collectionName: fields.collectionName.value as string };
}

/** Control-plane read only; protected by the existing tenants management ACL. */
export function createAccessConfigRead(app: Application) {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.currentUser?.id == null) ctx.throw(401, translateTenantError(ctx, 'authenticationRequired'));
    if (ctx.method !== 'POST') ctx.throw(405);
    try {
      const { dataSourceKey, collectionName } = selection(ctx.action.params.values);
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
      const store = new AccessConfigStore(primaryDb, () => {
        assertSource();
        if (
          db.getCollection(collectionName) !== collection ||
          collection.model !== model ||
          collection.options.key !== identity.collectionKey
        )
          conflict();
        return resolveModelMetadata(collection, { resolveCollectionKey });
      });
      const config = await store.read(identity);
      assertSource();
      const assertMetadata = accessMetadataGuard(db, [
        {
          model,
          config: config ?? { schemaVersion: 1, revision: 0, ownership: { enabled: false }, rules: [] },
        },
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
      ctx.body = { identity, config };
    } catch (error) {
      if (error instanceof AccessConfigError) {
        const key =
          error.code === 'ACCESS_CONFIG_CONFLICT'
            ? 'accessConfigReadConflict'
            : error.code === 'ACCESS_COLLECTION_NOT_FOUND'
              ? 'accessPreviewUnavailable'
              : 'accessConfigReadInvalid';
        ctx.throw(error.status, translateTenantError(ctx, key), { code: error.code });
      }
      if (error instanceof AccessRuleError)
        ctx.throw(400, translateTenantError(ctx, 'accessConfigReadInvalid'), { code: error.code });
      throw error;
    }
    await next();
  };
}
