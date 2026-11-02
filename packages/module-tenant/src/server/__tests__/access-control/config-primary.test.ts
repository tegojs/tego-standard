import { Database } from '@tego/server';

import type { AccessConfigStore } from '../../access-control/config-store';
import type { AccessConfig } from '../../access-control/types';
import { withAmbientTransactions } from './ambient-transactions';
import { configStore, initialConfig, mainIdentity, registerConfigModels, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, queryRows } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('configuration primary authority in async transactions', () => {
  let primary: Database;
  let routed: Database;
  let reader: AccessConfigStore;
  let current: AccessConfig;

  beforeEach(async () => {
    primary = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(primary);
    const store = configStore(primary);
    const first = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    await primary.sequelize.query('CREATE SCHEMA config_ambient_stale');
    for (const name of ['access_config_collections', 'tenantAccessRevisions']) {
      await primary.sequelize.query(
        `CREATE TABLE config_ambient_stale."${name}" (LIKE public."${name}" INCLUDING ALL)`,
      );
      await primary.sequelize.query(`INSERT INTO config_ambient_stale."${name}" SELECT * FROM public."${name}"`);
    }
    const second = await store.save(mainIdentity, { ...first, rules: [] }, { userId: 16 });
    current = await store.save(mainIdentity, { ...second, ownership: { enabled: false } }, { userId: 9 });
    const { host, port, database, username, password } = primary.options;
    const connection = { host, port, database, username, password };
    routed = new Database({
      ...primary.options,
      replication: {
        write: connection,
        read: [{ ...connection, dialectOptions: { application_name: 'config-ambient-reader' } }],
      },
    });
    routed.sequelize.addHook('afterConnect', async (connection, config) => {
      if (config.dialectOptions?.application_name === 'config-ambient-reader')
        await connection.query('SET search_path TO config_ambient_stale');
    });
    registerConfigModels(routed);
    reader = configStore(routed);
  });

  afterEach(async () => {
    if (routed) await routed.close();
    if (primary) {
      try {
        await primary.sequelize.query('DROP SCHEMA IF EXISTS config_ambient_stale CASCADE');
        await primary.sequelize.query(
          'DROP TABLE IF EXISTS "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
      } finally {
        await primary.close();
      }
    }
  });

  async function inReadTransaction(work: () => Promise<void>) {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction({ readOnly: true }, async (transaction) => {
        expect(await queryRows(routed, 'SELECT current_schema() AS schema', { transaction })).toEqual([
          { schema: 'config_ambient_stale' },
        ]);
        const record = await routed
          .getCollection('collections')
          .model.findByPk(mainIdentity.collectionKey, { transaction });
        expect(record.getDataValue('options').tenantAccess.revision).toBe(1);
        await work();
        expect(transaction.finished).toBeFalsy();
        expect(await queryRows(routed, 'SELECT current_schema() AS schema', { transaction })).toEqual([
          { schema: 'config_ambient_stale' },
        ]);
      });
    });
  }

  it('reads committed primary rules instead of the ambient read-pool configuration', async () => {
    await inReadTransaction(async () => {
      expect(await reader.read(mainIdentity)).toEqual(current);
    });
  });

  it('prepares a historical draft using the committed primary editing base', async () => {
    await inReadTransaction(async () => {
      expect(await reader.revisionDraft(mainIdentity, 1)).toMatchObject({ sourceRevision: 1, config: { revision: 3 } });
      expect((await reader.listRevisions(mainIdentity)).revisions.map((item) => item.revision)).toEqual([3, 2, 1]);
    });
  });

  it('does not expose retained history when only the ambient reader still contains the deleted collection', async () => {
    await primary.getRepository('collections').destroy({ filterByTk: 'documents' });
    expect(await primary.getRepository('tenantAccessRevisions').count()).toBe(3);
    await inReadTransaction(async () => {
      await expect(reader.listRevisions(mainIdentity)).rejects.toMatchObject({
        code: 'ACCESS_COLLECTION_NOT_FOUND',
        status: 404,
      });
    });
  });

  it('preserves owned save transactions while the caller holds an ambient reader', async () => {
    await inReadTransaction(async () => {
      const saved = await reader.save(mainIdentity, { ...current, ownership: { enabled: true } }, { userId: 8 });
      expect(saved.revision).toBe(4);
      expect(
        await primary.getCollection('tenantAccessRevisions').model.count({ useMaster: true, transaction: null }),
      ).toBe(4);
      expect(
        (
          await primary
            .getCollection('collections')
            .model.findByPk(mainIdentity.collectionKey, { useMaster: true, transaction: null })
        ).getDataValue('options').tenantAccess.revision,
      ).toBe(4);
    });
  });
});
