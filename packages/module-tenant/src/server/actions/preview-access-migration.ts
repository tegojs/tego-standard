import type { Application, Collection, Context, Next } from '@tego/server';

import { AccessAclScopeAdapter, snapshotRoleScopeSelections } from '../access-control/acl-scope';
import { AccessConfigError } from '../access-control/config-errors';
import { accessCollectionKey, AccessConfigStore } from '../access-control/config-store';
import { AccessMigrationPreviewService } from '../access-control/migration-preview';
import { resolveModelMetadata } from '../access-control/model-metadata';
import { AccessRuleError } from '../access-control/types';
import { translateTenantError } from '../locale';

function previewRequest(input: unknown) {
  const invalid = (): never => {
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid migration preview request');
  };
  if (
    !input ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length < 3 ||
    Reflect.ownKeys(input).length > 4
  )
    return invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    !['dataSourceKey', 'collectionName', 'roleActions'].every(
      (name) => Object.hasOwn(fields, name) && Object.hasOwn(fields[name], 'value'),
    ) ||
    !['dataSourceKey', 'collectionName'].every(
      (name) =>
        typeof fields[name].value === 'string' && fields[name].value.length > 0 && fields[name].value.length <= 255,
    )
  )
    return invalid();
  if (Object.hasOwn(fields, 'collectionKey')) {
    if (
      typeof fields.collectionKey.value !== 'string' ||
      fields.collectionKey.value.length === 0 ||
      fields.collectionKey.value.length > 255
    )
      return invalid();
  }
  if (
    Reflect.ownKeys(fields).some(
      (name) => !['dataSourceKey', 'collectionName', 'collectionKey', 'roleActions'].includes(name as string),
    )
  )
    return invalid();
  return {
    dataSourceKey: fields.dataSourceKey.value as string,
    collectionName: fields.collectionName.value as string,
    ...(typeof fields.collectionKey?.value === 'string' ? { collectionKey: fields.collectionKey.value } : {}),
    roleActions: snapshotRoleScopeSelections(fields.roleActions.value),
  };
}

/** Protected by the existing tenants management ACL; never add this action to loggedIn allows. */
export function createAccessMigrationPreview(app: Application) {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.currentUser?.id == null) ctx.throw(401, translateTenantError(ctx, 'authenticationRequired'));
    if (ctx.method !== 'POST') ctx.throw(405);
    try {
      const { dataSourceKey, collectionName, collectionKey, roleActions } = previewRequest(ctx.action.params.values);
      // Resolve from the trusted application, never ctx.db or request-provided runtime objects.
      const primaryDb = app.db;
      const manager = app.dataSourceManager;
      const source = dataSourceKey === 'main' ? undefined : manager.dataSources.get(dataSourceKey);
      const collectionManager = source?.collectionManager;
      const db = dataSourceKey === 'main' ? primaryDb : collectionManager?.db;
      const acl = dataSourceKey === 'main' ? app.acl : source?.acl;
      if (!db || !acl) throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Data source is unavailable', 404);
      const assertSource = () => {
        if (
          app.db !== primaryDb ||
          (dataSourceKey === 'main'
            ? app.acl !== acl
            : app.dataSourceManager !== manager ||
              manager.dataSources.get(dataSourceKey) !== source ||
              source?.collectionManager !== collectionManager ||
              collectionManager?.db !== db ||
              source?.acl !== acl)
        )
          throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Data source changed during preview', 409);
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
        throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Collection identity is unavailable', 404);
      const identity = { dataSourceKey, collectionName, collectionKey: records[0].get('key') as string };
      accessCollectionKey(identity);
      if (collectionKey && collectionKey !== identity.collectionKey) {
        throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'The collection changed during preview', 409);
      }
      const resolveCollectionKey = (collection: Collection) => {
        if (collection.options.key !== identity.collectionKey)
          throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Runtime collection identity changed', 409);
        return accessCollectionKey({
          dataSourceKey,
          collectionName: collection.name,
          collectionKey: collection.options.key,
        });
      };
      const store = new AccessConfigStore(primaryDb, () =>
        resolveModelMetadata(db.getCollection(collectionName), { resolveCollectionKey }),
      );
      const service = new AccessMigrationPreviewService(primaryDb, {
        dataSourceKey,
        db,
        scopes: new AccessAclScopeAdapter(acl, dataSourceKey, store, primaryDb),
        resolveCollectionKey,
      });
      const report = await service.preview(identity, roleActions);
      assertSource();
      ctx.body = report;
    } catch (error) {
      if (error instanceof AccessConfigError) {
        const key =
          error.code === 'ACCESS_CONFIG_CONFLICT'
            ? 'accessPreviewConflict'
            : error.code === 'ACCESS_COLLECTION_NOT_FOUND'
              ? 'accessPreviewUnavailable'
              : 'accessPreviewInvalid';
        ctx.throw(error.status, translateTenantError(ctx, key), { code: error.code });
      }
      if (error instanceof AccessRuleError)
        ctx.throw(400, translateTenantError(ctx, 'accessPreviewInvalid'), { code: error.code });
      throw error;
    }
    await next();
  };
}
