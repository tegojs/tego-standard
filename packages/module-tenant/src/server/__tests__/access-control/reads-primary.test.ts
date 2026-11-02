import { ACL, Database, type Collection } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessReadService } from '../../access-control/reads';
import { withAmbientTransactions } from './ambient-transactions';
import { mainIdentity, registerConfigModels, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, queryRows } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('root read execution uses its selected transaction', () => {
  let primary: Database;
  let routed: Database;
  let reads: AccessReadService;
  let ctx: object;
  const auth = { tenantId: 'B' };
  const fields = ['id', 'name', 'amount'];
  const owner = { id: 1, name: 'Owned', amount: 10 };

  function models(db: Database) {
    const documents = db.collection({
      name: 'documents',
      key: mainIdentity.collectionKey,
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
      ],
    });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    return documents;
  }

  beforeEach(async () => {
    primary = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(primary);
    models(primary);
    await primary.sync();
    await primary.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: true },
      { id: 'C', enabled: true },
    ]);
    await primary.getCollection('documents').model.bulkCreate([
      { ...owner, tenantId: 'B' },
      { id: 2, tenantId: 'C', name: 'Hidden', amount: 30 },
    ]);
    await primary.sequelize.query('CREATE SCHEMA read_ambient_stale');
    await primary.sequelize.query('CREATE TABLE read_ambient_stale.documents (LIKE public.documents INCLUDING ALL)');
    await primary.sequelize.query('INSERT INTO read_ambient_stale.documents SELECT * FROM public.documents');
    await primary.sequelize.query(
      `UPDATE read_ambient_stale.documents SET "tenantId"='B', name='Formerly owned', amount=900 WHERE id=2`,
    );
    const { host, port, database, username, password } = primary.options;
    const connection = { host, port, database, username, password };
    routed = new Database({
      ...primary.options,
      replication: {
        write: connection,
        read: [{ ...connection, dialectOptions: { application_name: 'read-ambient-reader' } }],
      },
    });
    routed.sequelize.addHook('afterConnect', async (connection, config) => {
      if (config.dialectOptions?.application_name === 'read-ambient-reader')
        await connection.query('SET search_path TO read_ambient_stale');
    });
    registerConfigModels(routed);
    const documents = models(routed);
    const key = (_collection: Collection) => accessCollectionKey(mainIdentity);
    const store = new AccessConfigStore(routed, () => resolveModelMetadata(documents, { resolveCollectionKey: key }));
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    const adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, routed);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    reads = new AccessReadService(routed, adapter, new AccessQueryService(routed, adapter, key), () => ({
      identity: mainIdentity,
      fields: ['id', 'tenantId', 'name', 'amount'],
    }));
  });

  afterEach(async () => {
    if (routed) await routed.close();
    if (primary) {
      try {
        await primary.sequelize.query('DROP SCHEMA IF EXISTS read_ambient_stale CASCADE');
        await primary.sequelize.query(
          'DROP TABLE IF EXISTS documents, tenants, "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
      } finally {
        await primary.close();
      }
    }
  });

  it.each([
    {
      name: 'list',
      execute: () => reads.list(ctx, mainIdentity, auth, { attributes: fields, sort: ['id'] }),
      want: [owner],
    },
    {
      name: 'list and count',
      execute: () => reads.listWithCount(ctx, mainIdentity, auth, { attributes: fields, sort: ['id'] }),
      want: { rows: [owner], count: 1 },
    },
    {
      name: 'hidden detail',
      execute: () => reads.get(ctx, mainIdentity, auth, { key: 2, attributes: fields }),
      want: null,
    },
    { name: 'count', execute: () => reads.count(ctx, mainIdentity, auth), want: 1 },
    { name: 'sum', execute: () => reads.sum(ctx, mainIdentity, auth, { field: 'amount' }), want: 10 },
    {
      name: 'maximum',
      execute: () => reads.aggregate(ctx, mainIdentity, auth, { field: 'amount', method: 'max' }),
      want: 10,
    },
    {
      name: 'grouped sum',
      execute: () =>
        reads.groupAggregate(ctx, mainIdentity, auth, { field: 'amount', method: 'sum', groupBy: ['tenantId'] }),
      want: [{ key: { tenantId: 'B' }, value: 10 }],
    },
  ])('does not inherit stale root facts for $name', async ({ execute, want }) => {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction({ readOnly: true }, async (transaction) => {
        expect(await queryRows(routed, 'SELECT current_schema() AS schema', { transaction })).toEqual([
          { schema: 'read_ambient_stale' },
        ]);
        expect(await execute()).toEqual(want);
        expect(transaction.finished).toBeFalsy();
      });
    });
  });

  it('preserves explicitly selected uncommitted rows without implicitly joining the caller transaction', async () => {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction(async (transaction) => {
        await routed.getCollection('documents').model.update({ name: 'Pending' }, { where: { id: 1 }, transaction });
        expect(await reads.get(ctx, mainIdentity, auth, { key: 1, attributes: fields, transaction })).toEqual({
          ...owner,
          name: 'Pending',
        });
        expect(await reads.get(ctx, mainIdentity, auth, { key: 1, attributes: fields })).toEqual(owner);
        expect(transaction.finished).toBeFalsy();
      });
    });
  });
});
