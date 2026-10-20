import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter, AccessRoleScopePreview, AccessRoleScopeSelection } from './acl-scope';
import { AccessConfigError } from './config-errors';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { draftLegacyAccessConfig } from './legacy-config';
import { accessMetadataGuard } from './metadata-snapshot';
import { resolveModelMetadata } from './model-metadata';
import type { AccessConfig } from './types';

interface EffectiveLegacySettings {
  tenancy: 'shared' | 'tenantScoped' | 'tenantInherited';
  legacyDataTenantIds: Array<string | number>;
  allowEditingLegacyData: boolean;
}

interface PreviewDataSource {
  dataSourceKey: string;
  db: Database;
  scopes: AccessAclScopeAdapter;
  resolveCollectionKey: (collection: Collection) => string;
}

export interface AccessMigrationPreview {
  identity: AccessCollectionIdentity;
  legacy: EffectiveLegacySettings;
  draft: AccessConfig;
  /** Only the explicitly selected role actions; neither a complete ACL decision nor migration permission. */
  roleScopes: AccessRoleScopePreview[];
}

const legacyKeys = ['tenancy', 'legacyDataTenantIds', 'allowEditingLegacyData'] as const;

function invalid(message: string): never {
  throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', message);
}

function conflict(): never {
  throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Collection changed; reload the migration preview', 409);
}

/** Read own data properties only; unrelated options do not participate in the preview. */
function legacyOverrides(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('Invalid collection options');
  const result: Record<string, unknown> = {};
  for (const key of legacyKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value')) invalid('Invalid legacy configuration property');
    result[key] = descriptor.value;
  }
  return result;
}

function effectiveSettings(collection: Collection): EffectiveLegacySettings {
  if (Object.hasOwn(collection.options, 'tenantAccess')) conflict();
  const settings = legacyOverrides(collection.options);
  // These are the existing runtime defaults for optional legacy settings, never a default isolation mode.
  return {
    tenancy: settings.tenancy,
    legacyDataTenantIds: settings.legacyDataTenantIds === undefined ? [] : settings.legacyDataTenantIds,
    allowEditingLegacyData: settings.allowEditingLegacyData === undefined ? false : settings.allowEditingLegacyData,
  } as EffectiveLegacySettings;
}

/** Internal read-only tooling. The eventual HTTP adapter must authenticate the administrator independently. */
export class AccessMigrationPreviewService {
  private readonly source: PreviewDataSource;

  constructor(
    private readonly primaryDb: Database,
    source: PreviewDataSource,
  ) {
    this.source = { ...source };
  }

  async preview(
    identity: AccessCollectionIdentity,
    selections: readonly AccessRoleScopeSelection[],
  ): Promise<AccessMigrationPreview> {
    const stableKey = accessCollectionKey(identity);
    identity = {
      dataSourceKey: identity.dataSourceKey,
      collectionKey: identity.collectionKey,
      collectionName: identity.collectionName,
    };
    const { db, scopes, dataSourceKey, resolveCollectionKey } = this.source;
    if (identity.dataSourceKey !== dataSourceKey) invalid('Migration data source does not match collection identity');
    const collection = db.getCollection(identity.collectionName);
    if (!collection || collection.db !== db || resolveCollectionKey(collection) !== stableKey)
      invalid('Migration runtime collection identity is unavailable');
    const model = collection.model;
    const metadata = resolveModelMetadata(collection, { resolveCollectionKey });
    const effective = effectiveSettings(collection);
    const draft = draftLegacyAccessConfig(effective, metadata);
    const legacy = structuredClone(effective);
    const assertMetadata = accessMetadataGuard(db, [{ model, config: draft }]);
    const assertRuntime = () => {
      const current = effectiveSettings(collection);
      draftLegacyAccessConfig(current, metadata);
      if (
        db.getCollection(identity.collectionName) !== collection ||
        collection.model !== model ||
        resolveCollectionKey(collection) !== stableKey ||
        !isDeepStrictEqual(current, legacy)
      )
        conflict();
      assertMetadata();
    };
    const captured = scopes.captureRoleScopes(identity.collectionName, selections);
    const readPersisted = async () => {
      const name = identity.dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections';
      const record = await this.primaryDb.getCollection(name)?.model.findOne({
        where: {
          key: identity.collectionKey,
          name: identity.collectionName,
          ...(name === 'dataSourcesCollections' ? { dataSourceKey: identity.dataSourceKey } : {}),
        },
        useMaster: true,
      });
      if (!record)
        throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Collection metadata identity is unavailable', 404);
      const options: unknown = record.getDataValue('options') ?? {};
      if (typeof options !== 'object' || !options || Array.isArray(options))
        invalid('Invalid collection metadata options');
      // Even an invalid/newer configuration must not be silently replaced by a legacy draft.
      if (Object.hasOwn(options, 'tenantAccess')) conflict();
      const overrides = legacyOverrides(options);
      if (!isDeepStrictEqual(draftLegacyAccessConfig({ ...legacy, ...overrides }, metadata), draft)) conflict();
      return structuredClone(overrides);
    };
    const persisted = await readPersisted();
    assertRuntime();
    const roleScopes = await captured.read();
    if (roleScopes.some((item) => item.dataSourceKey !== dataSourceKey))
      invalid('Role inspection belongs to another data source');
    const latest = await readPersisted();
    if (!isDeepStrictEqual(persisted, latest)) conflict();
    assertRuntime();
    captured.assertCurrent();
    // A detached report only: saving/activation must revalidate authority, revision and supported entry coverage.
    return { identity, legacy, draft, roleScopes };
  }
}
