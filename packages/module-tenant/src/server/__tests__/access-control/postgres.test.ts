import { Database, Op, Transaction } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import { resolveAccessContext } from '../../access-control/context';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { isolatedPostgresDatabase, queryRows, seedDatabase, selectDocuments } from './database';
import { configFor, documents, exampleConfig, participantCondition, quoteIdentifier } from './fixtures';

const databaseUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

async function serializablePair(db: Database, run: (writer: Transaction, changer: Transaction) => Promise<void>) {
  const writer = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
  let changer: Transaction;
  try {
    changer = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
    await run(writer, changer);
  } finally {
    if (!writer.finished) await writer.rollback();
    if (changer && !changer.finished) await changer.rollback();
  }
}

describe.skipIf(!databaseUrl)('tenant access PostgreSQL prototype', () => {
  let db: Database;

  beforeEach(async () => {
    db = isolatedPostgresDatabase(databaseUrl);
    await seedDatabase(db);
  });

  afterEach(async () => {
    if (!db) return;
    try {
      await db.sequelize.query(
        'DROP TABLE IF EXISTS access_documents, access_participants, access_links, access_tenants',
      );
    } finally {
      await db.close();
    }
  });

  it.each([
    ['H', [1, 2, 6], 900, [1, 2, 6]],
    ['B', [1, 3], 400, [3]],
    ['C', [4, 6], 1000, [4]],
  ] as const)(
    'preserves the specified read, write and aggregate sets for %s',
    async (tenant, readable, amount, writable) => {
      expect((await selectDocuments(db, tenant)).map((row) => row.id)).toEqual(readable);
      expect((await selectDocuments(db, tenant, 'ownership')).map((row) => row.id)).toEqual(writable);
      const scope = compileAccessScopes(exampleConfig, {
        collection: documents,
        context: { 'tenant.id': tenant },
        quoteIdentifier,
      }).read;
      const [total] = await queryRows<{ count: string; amount: string }>(
        db,
        `SELECT COUNT(*) AS count, SUM(amount) AS amount FROM access_documents AS tac_root WHERE ${scope.sql}`,
        { bind: scope.bind },
      );
      expect(Number(total.count)).toBe(readable.length);
      expect(Number(total.amount)).toBe(amount);
    },
  );

  it('rejects writes started after a relationship revocation has committed', async () => {
    const scope = compileAccessScopes(configFor(participantCondition), {
      collection: documents,
      context: { 'tenant.id': 'B' },
      quoteIdentifier,
    }).ownership;
    await db.sequelize.query("DELETE FROM access_participants WHERE document_id = 1 AND business_tenant = 'B'");
    const changed = await queryRows<{ id: number }>(
      db,
      `UPDATE access_documents AS tac_root SET amount = 101 WHERE id = 1 AND ${scope.sql} RETURNING id`,
      { bind: scope.bind },
    );
    expect(changed).toEqual([]);
    const [record] = await queryRows<{ amount: number }>(db, 'SELECT amount FROM access_documents WHERE id = 1');
    expect(record.amount).toBe(100);
  });

  it('executes real model metadata with target and root restrictions', async () => {
    const root = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'amount', type: 'integer' },
      ],
    });
    db.collection({
      name: 'participants',
      tableName: 'access_participants',
      timestamps: false,
      fields: [
        { name: 'documentId', type: 'bigInt', field: 'document_id' },
        { name: 'businessTenant', type: 'string', field: 'business_tenant' },
        { name: 'canView', type: 'boolean', field: 'can_view' },
      ],
    });
    root.setField('participants', {
      type: 'hasMany',
      target: 'participants',
      foreignKey: 'documentId',
      scope: { canView: true },
    });
    root.model.addScope('defaultScope', { where: { amount: { [Op.gte]: 200 } } }, { override: true });
    const scope = compileAccessScopes(
      configFor({ type: 'exists', path: 'participants', condition: { type: 'constant', value: true } }),
      {
        collection: resolveModelMetadata(root, { resolveCollectionKey: (collection) => `test:${collection.name}` }),
        context: {},
        quoteIdentifier,
      },
    ).read;
    expect(
      await queryRows(db, `SELECT id FROM access_documents AS tac_root WHERE ${scope.sql} ORDER BY id`, {
        bind: scope.bind,
      }),
    ).toEqual([{ id: 6 }]);
  });

  it('resolves actual model hierarchy inside a PostgreSQL write transaction', async () => {
    await db.sequelize.query('ALTER TABLE access_tenants ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE');
    db.collection({
      name: 'tenants',
      tableName: 'access_tenants',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string', field: 'parent_id' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    const config = configFor({
      type: 'tenantRelation',
      tenant: { type: 'field', path: 'tenantId' },
      relation: 'ancestor',
      includeSelf: true,
    });
    const transaction = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
    try {
      await db.sequelize.query("UPDATE access_tenants SET parent_id = NULL WHERE id = 'B'", { transaction });
      const context = await resolveAccessContext(db, config, { tenantId: 'H' }, { transaction });
      expect(context['tenant.descendantIds']).toEqual(['C']);
      const scope = compileAccessScopes(config, { collection: documents, context, quoteIdentifier }).ownership;
      expect(
        await queryRows(db, `SELECT id FROM access_documents AS tac_root WHERE ${scope.sql} ORDER BY id`, {
          bind: scope.bind,
          transaction,
        }),
      ).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }, { id: 6 }]);
    } finally {
      if (!transaction.finished) await transaction.rollback();
    }
    expect((await resolveAccessContext(db, config, { tenantId: 'H' }))['tenant.descendantIds']).toEqual(['B', 'C']);
  });

  it.each(['exists', 'not-exists'])('rolls back an inconsistent concurrent %s authorization snapshot', async (mode) => {
    const condition = mode === 'exists' ? participantCondition : { type: 'not' as const, child: participantCondition };
    const documentId = mode === 'exists' ? 1 : 2;
    const scope = compileAccessScopes(configFor(condition), {
      collection: documents,
      context: { 'tenant.id': 'B' },
      quoteIdentifier,
    }).ownership;
    await serializablePair(db, async (writer, changer) => {
      const authorized = await queryRows<{ id: number }>(
        db,
        `SELECT id FROM access_documents AS tac_root WHERE id = $document_id AND ${scope.sql}`,
        { bind: { ...scope.bind, document_id: documentId }, transaction: writer },
      );
      expect(authorized.map((row) => row.id)).toEqual([documentId]);
      await queryRows(db, 'SELECT amount FROM access_documents WHERE id = $document_id', {
        bind: { document_id: documentId },
        transaction: changer,
      });
      if (mode === 'exists') {
        await db.sequelize.query("DELETE FROM access_participants WHERE document_id = 1 AND business_tenant = 'B'", {
          transaction: changer,
        });
      } else {
        await db.sequelize.query("INSERT INTO access_participants VALUES (9, 2, 'B', TRUE)", { transaction: changer });
      }
      await changer.commit();
      await expect(
        (async () => {
          await db.sequelize.query(
            `UPDATE access_documents AS tac_root SET amount = amount + 1 WHERE id = $document_id AND ${scope.sql}`,
            { bind: { ...scope.bind, document_id: documentId }, transaction: writer },
          );
          await writer.commit();
        })(),
      ).rejects.toMatchObject({ original: { code: '40001' } });
    });
    const [record] = await queryRows<{ amount: number }>(
      db,
      'SELECT amount FROM access_documents WHERE id = $document_id',
      { bind: { document_id: documentId } },
    );
    expect(record.amount).toBe(documentId * 100);
  });

  it('includes hierarchy resolution in the same authorization transaction', async () => {
    await serializablePair(db, async (writer, changer) => {
      // The real adapter must resolve hierarchy inside this transaction, never reuse a cached list.
      const descendants = await queryRows<{ id: string }>(db, "SELECT id FROM access_tenants WHERE parent_id = 'H'", {
        transaction: writer,
      });
      const scope = compileAccessScopes(
        configFor({
          type: 'tenantRelation',
          tenant: { type: 'field', path: 'tenantId' },
          relation: 'ancestor',
          includeSelf: true,
        }),
        {
          collection: documents,
          context: { 'tenant.id': 'H', 'tenant.descendantIds': descendants.map((row) => row.id) },
          quoteIdentifier,
        },
      ).ownership;
      expect(
        await queryRows(db, `SELECT id FROM access_documents AS tac_root WHERE id = 3 AND ${scope.sql}`, {
          bind: scope.bind,
          transaction: writer,
        }),
      ).toHaveLength(1);
      await queryRows(db, 'SELECT amount FROM access_documents WHERE id = 3', { transaction: changer });
      await db.sequelize.query("UPDATE access_tenants SET parent_id = NULL WHERE id = 'B'", { transaction: changer });
      await changer.commit();
      await expect(
        (async () => {
          await db.sequelize.query(
            `UPDATE access_documents AS tac_root SET amount = 301 WHERE id = 3 AND ${scope.sql}`,
            { bind: scope.bind, transaction: writer },
          );
          await writer.commit();
        })(),
      ).rejects.toMatchObject({ original: { code: '40001' } });
    });
    const [record] = await queryRows<{ amount: number }>(db, 'SELECT amount FROM access_documents WHERE id = 3');
    expect(record.amount).toBe(300);
  });

  it('allows exactly one first claimant of a legacy row', async () => {
    const first = await db.sequelize.transaction();
    const second = await db.sequelize.transaction();
    try {
      await queryRows(db, 'SELECT tenant_id FROM access_documents WHERE id = 5', { transaction: first });
      await queryRows(db, 'SELECT tenant_id FROM access_documents WHERE id = 5', { transaction: second });
      const claimed = await queryRows<{ tenant_id: string }>(
        db,
        "UPDATE access_documents SET tenant_id = 'B' WHERE id = 5 AND tenant_id IS NULL RETURNING tenant_id",
        { transaction: first },
      );
      expect(claimed).toEqual([{ tenant_id: 'B' }]);
      const competing = queryRows(
        db,
        "UPDATE access_documents SET tenant_id = 'C' WHERE id = 5 AND tenant_id IS NULL RETURNING tenant_id",
        { transaction: second },
      );
      await first.commit();
      expect(await competing).toEqual([]);
      await second.commit();
    } finally {
      if (!first.finished) await first.rollback();
      if (!second.finished) await second.rollback();
    }
  });

  it('measures bounded SQL on 20000 records without duplicate counts', async () => {
    await db.sequelize.query(
      "INSERT INTO access_documents SELECT n, 'H', 100, 'Bulk-' || n FROM generate_series(100, 20099) AS n",
    );
    await db.sequelize.query(
      "INSERT INTO access_participants SELECT n * 2 + copy, n, CASE WHEN n % 20 = 0 THEN 'B' ELSE 'C' END, TRUE FROM generate_series(100, 20099) AS n CROSS JOIN generate_series(0, 1) AS copy",
    );
    await db.sequelize.query('ANALYZE access_documents');
    await db.sequelize.query('ANALYZE access_participants');
    const scope = compileAccessScopes(exampleConfig, {
      collection: documents,
      context: { 'tenant.id': 'B' },
      quoteIdentifier,
    }).read;
    const [total] = await queryRows<{ count: string; amount: string }>(
      db,
      `SELECT COUNT(*) AS count, SUM(amount) AS amount FROM access_documents AS tac_root WHERE ${scope.sql}`,
      { bind: scope.bind },
    );
    expect(Number(total.count)).toBe(1002);
    expect(Number(total.amount)).toBe(100400);
    const measurements: Array<{ pageSize: number; p95Ms: number }> = [];
    for (const pageSize of [20, 100]) {
      const times: number[] = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const rows = await queryRows<{ 'QUERY PLAN': Array<{ 'Execution Time': number }> }>(
          db,
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM access_documents AS tac_root WHERE ${scope.sql} ORDER BY id LIMIT ${pageSize}`,
          { bind: scope.bind },
        );
        times.push(rows[0]['QUERY PLAN'][0]['Execution Time']);
      }
      times.sort((left, right) => left - right);
      measurements.push({ pageSize, p95Ms: times[times.length - 1] });
    }
    console.info(
      'Tenant access PostgreSQL prototype:',
      JSON.stringify({ records: 20006, participants: 40004, measurements }),
    );
  });
});
