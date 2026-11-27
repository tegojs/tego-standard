import { ACL, Database, type Collection } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMigrationPreviewService } from '../../access-control/migration-preview';
import { withAmbientTransactions } from './ambient-transactions';
import {
  configStore,
  externalIdentity,
  initialConfig,
  mainIdentity,
  registerConfigModels,
  seedConfigStore,
} from './config-database';
import { isolatedPostgresDatabase, queryRows } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const identities = [mainIdentity, externalIdentity];

describe.skipIf(!postgresUrl)('migration preview uses committed primary collection metadata', () => {
  let primary: Database;
  let routed: Database;
  let documents: Collection;

  beforeEach(async () => {
    primary = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(primary);
    await primary.sequelize.query('CREATE SCHEMA migration_ambient_stale');
    for (const table of ['access_config_collections', 'access_config_dataSourcesCollections']) {
      await primary.sequelize.query(
        `CREATE TABLE migration_ambient_stale."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
      await primary.sequelize.query(`INSERT INTO migration_ambient_stale."${table}" SELECT * FROM public."${table}"`);
    }
    const { host, port, database, username, password } = primary.options;
    const connection = { host, port, database, username, password };
    routed = new Database({
      ...primary.options,
      replication: {
        write: connection,
        read: [{ ...connection, dialectOptions: { application_name: 'migration-ambient-reader' } }],
      },
    });
    routed.sequelize.addHook('afterConnect', async (connection, config) => {
      if (config.dialectOptions?.application_name === 'migration-ambient-reader')
        await connection.query('SET search_path TO migration_ambient_stale');
    });
    registerConfigModels(routed);
    documents = routed.collection({
      name: 'documents',
      key: mainIdentity.collectionKey,
      tenancy: 'tenantScoped',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
  });

  afterEach(async () => {
    if (routed) await routed.close();
    if (primary) {
      try {
        await primary.sequelize.query('DROP SCHEMA IF EXISTS migration_ambient_stale CASCADE');
        await primary.sequelize.query(
          'DROP TABLE IF EXISTS "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
      } finally {
        await primary.close();
      }
    }
  });

  function preview(identity: AccessCollectionIdentity) {
    documents.options.key = identity.collectionKey;
    const service = new AccessMigrationPreviewService(routed, {
      dataSourceKey: identity.dataSourceKey,
      db: routed,
      scopes: new AccessAclScopeAdapter(new ACL(), identity.dataSourceKey, configStore(routed), routed),
      resolveCollectionKey: (collection) => accessCollectionKey({ ...identity, collectionKey: collection.options.key }),
    });
    return service.preview(identity, []);
  }

  async function inOldReader(work: () => Promise<void>) {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction({ readOnly: true }, async (transaction) => {
        expect(await queryRows(routed, 'SELECT current_schema() AS schema', { transaction })).toEqual([
          { schema: 'migration_ambient_stale' },
        ]);
        await work();
        expect(transaction.finished).toBeFalsy();
      });
    });
  }

  it.each(
    identities.flatMap((identity) => ['configured', 'removed', 'changed'].map((change) => ({ identity, change }))),
  )('rejects $identity.dataSourceKey metadata that was $change on primary', async ({ identity, change }) => {
    const model = primary.getCollection(
      identity.dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections',
    ).model;
    const where = { key: identity.collectionKey };
    if (change === 'configured') await configStore(primary).save(identity, initialConfig(), { userId: 28 });
    else if (change === 'removed') await model.destroy({ where });
    else await model.update({ options: { tenancy: 'shared' } }, { where });
    await inOldReader(async () => {
      await expect(preview(identity)).rejects.toMatchObject({
        code: change === 'removed' ? 'ACCESS_COLLECTION_NOT_FOUND' : 'ACCESS_CONFIG_CONFLICT',
      });
    });
  });

  it.each(identities)('still previews unchanged $dataSourceKey metadata without saving', async (identity) => {
    await inOldReader(async () => {
      expect(await preview(identity)).toMatchObject({
        identity,
        legacy: { tenancy: 'tenantScoped', legacyDataTenantIds: [], allowEditingLegacyData: false },
        draft: { revision: 0, ownership: { enabled: true } },
        roleScopes: [],
      });
    });
    expect(await configStore(primary).read(identity)).toBeNull();
    expect(await primary.getCollection('tenantAccessRevisions').model.count()).toBe(0);
  });

  it('does not mistake caller uncommitted settings for primary committed metadata', async () => {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction(async (transaction) => {
        await routed
          .getCollection('collections')
          .model.update(
            { options: { tenancy: 'shared' } },
            { where: { key: mainIdentity.collectionKey }, transaction },
          );
        expect(await preview(mainIdentity)).toMatchObject({ legacy: { tenancy: 'tenantScoped' } });
        expect(transaction.finished).toBeFalsy();
      });
    });
  });
});
