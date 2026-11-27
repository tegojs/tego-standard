import { ACL, Database, type Application } from '@tego/server';

import { createAccessMigrationPreview } from '../../actions/preview-access-migration';
import { createAccessConfigRead } from '../../actions/read-access-config';
import { withAmbientTransactions } from './ambient-transactions';
import { externalIdentity, mainIdentity, registerConfigModels, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, queryRows } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const selections = [mainIdentity, externalIdentity].flatMap((identity) =>
  ['read', 'preview'].map((operation) => ({ identity, operation })),
);

describe.skipIf(!postgresUrl)('administrator actions discover collection identity on committed primary', () => {
  let primary: Database;
  let routed: Database;
  let app: Application;

  beforeEach(async () => {
    primary = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(primary);
    await primary.sequelize.query('CREATE SCHEMA admin_ambient_stale');
    for (const table of ['access_config_collections', 'access_config_dataSourcesCollections']) {
      await primary.sequelize.query(
        `CREATE TABLE admin_ambient_stale."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
      await primary.sequelize.query(`INSERT INTO admin_ambient_stale."${table}" SELECT * FROM public."${table}"`);
    }
    const { host, port, database, username, password } = primary.options;
    const connection = { host, port, database, username, password };
    routed = new Database({
      ...primary.options,
      replication: {
        write: connection,
        read: [{ ...connection, dialectOptions: { application_name: 'admin-ambient-reader' } }],
      },
    });
    routed.sequelize.addHook('afterConnect', async (connection, config) => {
      if (config.dialectOptions?.application_name === 'admin-ambient-reader')
        await connection.query('SET search_path TO admin_ambient_stale');
    });
    registerConfigModels(routed);
    for (const [db, identity] of [
      [routed, mainIdentity],
      [primary, externalIdentity],
    ] as const)
      db.collection({
        name: 'documents',
        key: identity.collectionKey,
        tenancy: 'tenantScoped',
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
    app = {
      db: routed,
      acl: new ACL(),
      dataSourceManager: {
        dataSources: new Map([['external', { collectionManager: { db: primary }, acl: new ACL() }]]),
      },
    } as unknown as Application;
  });

  afterEach(async () => {
    if (routed) await routed.close();
    if (primary) {
      try {
        await primary.sequelize.query('DROP SCHEMA IF EXISTS admin_ambient_stale CASCADE');
        await primary.sequelize.query(
          'DROP TABLE IF EXISTS "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
      } finally {
        await primary.close();
      }
    }
  });

  async function invoke({ identity, operation }: (typeof selections)[number]) {
    const ctx = {
      method: 'POST',
      state: { currentUser: { id: 28 }, currentRole: 'manager' },
      action: {
        params: {
          values: {
            dataSourceKey: identity.dataSourceKey,
            collectionName: identity.collectionName,
            ...(operation === 'preview' ? { roleActions: [] } : {}),
          },
        },
      },
      body: undefined as unknown,
      t: (message: string) => message,
      throw: (status: number, message?: string, properties?: object): never => {
        throw Object.assign(new Error(message), { status, ...properties });
      },
    };
    const action = operation === 'preview' ? createAccessMigrationPreview(app) : createAccessConfigRead(app);
    await action(ctx as never, async () => {});
    if (operation === 'preview') expect(ctx.body).toMatchObject({ identity, draft: { revision: 0 }, roleScopes: [] });
    else expect(ctx.body).toEqual({ identity, config: null });
  }

  it.each(selections.flatMap((selection) => ['missing', 'ambiguous'].map((state) => ({ ...selection, state }))))(
    'returns current $identity.dataSourceKey $operation results despite $state reader metadata',
    async ({ identity, operation, state }) => {
      const table =
        identity.dataSourceKey === 'main' ? 'access_config_collections' : 'access_config_dataSourcesCollections';
      if (state === 'missing') await primary.sequelize.query(`DELETE FROM admin_ambient_stale."${table}"`);
      else
        await primary.sequelize.query(
          `INSERT INTO admin_ambient_stale."${table}" (key, name, options${identity.dataSourceKey === 'main' ? '' : ', "dataSourceKey"'}) VALUES ('stale-duplicate', 'documents', '{}'${identity.dataSourceKey === 'main' ? '' : ", 'external'"})`,
        );
      await withAmbientTransactions(routed, async () => {
        await routed.sequelize.transaction({ readOnly: true }, async (transaction) => {
          expect(await queryRows(routed, 'SELECT current_schema() AS schema', { transaction })).toEqual([
            { schema: 'admin_ambient_stale' },
          ]);
          await invoke({ identity, operation });
          expect(transaction.finished).toBeFalsy();
        });
      });
      expect(await primary.getCollection('tenantAccessRevisions').model.count()).toBe(0);
    },
  );

  it.each(selections)(
    'ignores caller uncommitted $identity.dataSourceKey identity removal for $operation',
    async (selection) => {
      await withAmbientTransactions(routed, async () => {
        await routed.sequelize.transaction(async (transaction) => {
          await routed
            .getCollection(selection.identity.dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections')
            .model.destroy({
              where: { key: selection.identity.collectionKey },
              transaction,
            });
          await invoke(selection);
          expect(transaction.finished).toBeFalsy();
        });
      });
    },
  );
});
