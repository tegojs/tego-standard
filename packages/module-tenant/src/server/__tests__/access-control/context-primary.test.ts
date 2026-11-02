import { Database } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import { resolveAccessContext } from '../../access-control/context';
import { isolatedPostgresDatabase, queryRows } from './database';
import { configFor, documents, quoteIdentifier } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Real independent pools with divergent search paths model stale facts; no WAL replica is started.
describe.skipIf(!postgresUrl)('tenant hierarchy uses primary authority', () => {
  let primary: Database;
  let routed: Database;

  function tenants(db: Database) {
    return db.collection({
      name: 'tenants',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
  }

  beforeEach(async () => {
    primary = isolatedPostgresDatabase(postgresUrl!);
    const model = tenants(primary).model;
    await primary.sync();
    await model.bulkCreate([
      { id: 'H', parentId: null, enabled: true },
      { id: 'B', parentId: 'H', enabled: true },
      { id: 'C', parentId: null, enabled: true },
    ]);
    await primary.sequelize.query('CREATE SCHEMA tenant_context_stale');
    await primary.sequelize.query('CREATE TABLE tenant_context_stale.tenants (LIKE public.tenants INCLUDING ALL)');
    await primary.sequelize.query('INSERT INTO tenant_context_stale.tenants SELECT * FROM public.tenants');
    await primary.sequelize.query(`UPDATE tenant_context_stale.tenants SET "parentId"='H' WHERE id='C'`);
    await primary.sequelize.query('CREATE TABLE access_documents (id INTEGER PRIMARY KEY, tenant_id VARCHAR(50))');
    await primary.sequelize.query(`INSERT INTO access_documents VALUES (1, 'B'), (2, 'C')`);

    const { host, port, database, username, password } = primary.options;
    const connection = { host, port, database, username, password };
    routed = new Database({
      ...primary.options,
      replication: {
        write: connection,
        read: [{ ...connection, dialectOptions: { application_name: 'tenant-context-stale' } }],
      },
    });
    // Database's own afterConnect resets search_path to public. Set the read fixture afterwards.
    routed.sequelize.addHook('afterConnect', async (connection, config) => {
      if (config.dialectOptions?.application_name === 'tenant-context-stale')
        await connection.query('SET search_path TO tenant_context_stale');
    });
    tenants(routed);
    // Prove the actual read pool is divergent, while useMaster reaches current primary facts.
    expect((await routed.getCollection('tenants').model.findByPk('C'))?.get('parentId')).toBe('H');
    expect(
      (await routed.getCollection('tenants').model.findByPk('C', { useMaster: true }))?.get('parentId'),
    ).toBeNull();
  });

  afterEach(async () => {
    if (routed) await routed.close();
    if (primary) {
      try {
        await primary.sequelize.query('DROP SCHEMA IF EXISTS tenant_context_stale CASCADE');
        await primary.sequelize.query('DROP TABLE IF EXISTS access_documents, tenants');
      } finally {
        await primary.close();
      }
    }
  });

  it.each(['ownership', 'visibility'] as const)(
    'does not grant stale descendants through %s rules',
    async (category) => {
      const config = configFor(
        {
          type: 'tenantRelation',
          relation: 'ancestor',
          tenant: { type: 'field', path: 'tenantId' },
          includeSelf: true,
        },
        category,
      );
      const context = await resolveAccessContext(routed, config, { tenantId: 'H' });
      const scopes = compileAccessScopes(config, { collection: documents, context, quoteIdentifier });
      const scope = scopes.read;
      const rows = await queryRows(
        primary,
        `SELECT id FROM access_documents AS tac_root WHERE ${scope.sql} ORDER BY id`,
        { bind: scope.bind },
      );
      expect(rows).toEqual([{ id: 1 }]);
      expect(context['tenant.descendantIds']).toEqual(['B']);
      const writes = await queryRows(
        primary,
        `SELECT id FROM access_documents AS tac_root WHERE ${scopes.ownership.sql} ORDER BY id`,
        { bind: scopes.ownership.bind },
      );
      expect(writes).toEqual(category === 'ownership' ? [{ id: 1 }] : []);
    },
  );

  it('rejects a tenant disabled on the primary even while the read pool still enables it', async () => {
    await primary.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'C' } });
    expect((await routed.getCollection('tenants').model.findByPk('C'))?.get('enabled')).toBe(true);
    const config = configFor({
      type: 'tenantRelation',
      relation: 'ancestor',
      tenant: { type: 'field', path: 'tenantId' },
      includeSelf: true,
    });
    await expect(resolveAccessContext(routed, config, { tenantId: 'C' })).rejects.toThrow(/missing or disabled/);
  });

  it('does not grant an ancestor left only in the stale read pool', async () => {
    const config = configFor({
      type: 'tenantRelation',
      relation: 'descendant',
      tenant: { type: 'field', path: 'tenantId' },
      includeSelf: false,
    });
    expect(await resolveAccessContext(routed, config, { tenantId: 'C' })).toEqual({
      'tenant.id': 'C',
      'tenant.ancestorIds': [],
    });
  });

  it('preserves the caller transaction and its uncommitted hierarchy facts', async () => {
    const config = configFor({
      type: 'tenantRelation',
      relation: 'ancestor',
      tenant: { type: 'field', path: 'tenantId' },
      includeSelf: true,
    });
    const transaction = await routed.sequelize.transaction();
    try {
      await routed.getCollection('tenants').model.update({ parentId: null }, { where: { id: 'B' }, transaction });
      expect(
        (await resolveAccessContext(routed, config, { tenantId: 'H' }, { transaction }))['tenant.descendantIds'],
      ).toEqual([]);
      expect(transaction.finished).toBeFalsy();
    } finally {
      await transaction.rollback();
    }
    expect((await primary.getCollection('tenants').model.findByPk('B'))?.get('parentId')).toBe('H');
  });

  it.each([false, true])(
    'rejects a read-pool transaction (savepoint: %s) instead of stale authorization',
    async (nested) => {
      const config = configFor({
        type: 'tenantRelation',
        relation: 'ancestor',
        tenant: { type: 'field', path: 'tenantId' },
        includeSelf: true,
      });
      const parent = await routed.sequelize.transaction({ readOnly: true });
      const transaction = nested ? await routed.sequelize.transaction({ transaction: parent }) : parent;
      try {
        expect((await routed.getCollection('tenants').model.findByPk('C', { transaction }))?.get('parentId')).toBe('H');
        await expect(resolveAccessContext(routed, config, { tenantId: 'H' }, { transaction })).rejects.toThrow(
          /transaction/i,
        );
        expect(
          await resolveAccessContext(routed, configFor({ type: 'constant', value: true }), {}, { transaction }),
        ).toEqual({});
        expect(transaction.finished).toBeFalsy();
      } finally {
        try {
          if (nested) await transaction.rollback();
        } finally {
          await parent.rollback();
        }
      }
    },
  );
});
