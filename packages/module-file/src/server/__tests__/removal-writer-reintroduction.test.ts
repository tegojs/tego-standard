import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, type Collection, type Database } from '@tego/server';

import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { lockAttachmentRemovalReferenceScope } from '../storages/removal-reference-scope';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Explicit isolated SQL fixtures only. These candidate gates do not install a product writer
// protocol, bind a removal UUID/object, or authorize unlink. All existing file bytes are retained.
describe.skipIf(!postgresUrl)('PostgreSQL removal writer reintroduction boundaries', () => {
  let db: Database;
  let writer: Database;
  let source: Collection;
  let storages: Collection;
  let mapped: Collection;
  const values = { id: 2, path: 'nested', filename: 'retained.txt', storageId: 18 };

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    writer = isolatedPostgresDatabase(postgresUrl!);
    source = db.collection({
      name: 'writer_files',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'path', type: 'string' },
        { name: 'filename', type: 'string' },
        { name: 'storageId', type: 'integer' },
      ],
    });
    storages = db.collection({
      name: 'storages',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'type', type: 'string' },
        { name: 'options', type: 'jsonb' },
      ],
    });
    mapped = writer.collection({ ...source.options });
    await db.sync();
    await storages.repository.create({ values: { id: 18, type: 'local', options: { documentRoot: 'unused' } } });
    await db.sequelize.query('CREATE TABLE writer_gate (id integer PRIMARY KEY, reserved boolean NOT NULL)');
  });

  afterEach(async () => {
    try {
      await db.sequelize.query('DROP FUNCTION IF EXISTS writer_guard() CASCADE');
      await db.sequelize.query('DROP TABLE IF EXISTS writer_gate');
      await db.sequelize.drop({ cascade: true });
    } finally {
      await writer?.close();
      await db?.close();
    }
  });

  const transaction = () => db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
  const lock = (tx: Transaction) => lockAttachmentRemovalReferenceScope(db, [source], storages, tx);
  const query = (sql: string, tx?: Transaction) => db.sequelize.query(sql, { transaction: tx });

  async function installCandidate(mode: 'lookup' | 'write-existing') {
    await query(`CREATE FUNCTION writer_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $fixture$
      DECLARE held boolean;
      BEGIN
        ${
          mode === 'lookup'
            ? 'SELECT reserved INTO held FROM public.writer_gate WHERE id=1;'
            : `UPDATE public.writer_gate SET reserved=reserved WHERE id=1 RETURNING reserved INTO held;
               IF NOT FOUND THEN RAISE EXCEPTION 'fixture gate missing'; END IF;`
        }
        IF held THEN RAISE EXCEPTION 'fixture gate reserved'; END IF;
        RETURN NEW;
      END $fixture$`);
    await query(`CREATE TRIGGER writer_guard BEFORE INSERT OR UPDATE ON writer_files
      FOR EACH ROW EXECUTE FUNCTION writer_guard()`);
  }

  async function waitForLock(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [rows] = await db.sequelize.query(
        "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=$pid",
        { bind: { pid } },
      );
      if ((rows as { blocked: boolean }[])[0]?.blocked) return;
      await delay(20);
    }
    throw new Error('Expected actual PostgreSQL lock wait');
  }

  async function waitingWriter(
    reserve: (tx: Transaction) => Promise<unknown>,
    isolationLevel = Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
  ) {
    const write = await writer.sequelize.transaction({ isolationLevel });
    let read: Transaction | undefined;
    let insertion: Promise<{ error?: { parent?: { code?: string }; message?: string } }> | undefined;
    try {
      // The client already selected the old location and the transaction fixed its snapshot.
      const [pids] = await writer.sequelize.query('SELECT pg_backend_pid() AS pid', { transaction: write });
      read = await transaction();
      const scope = await lock(read);
      expect(await source.model.count({ transaction: read })).toBe(0);
      await reserve(read);
      insertion = mapped.repository.create({ values, transaction: write }).then(
        () => ({}),
        (error) => ({ error }),
      );
      await waitForLock((pids as { pid: number }[])[0].pid);
      await scope.assertCurrent();
      await read.commit();
      const result = await insertion;
      if (!result.error) await write.commit();
      return result;
    } finally {
      if (read && !read.finished) await read.rollback();
      await insertion;
      if (!write.finished) await write.rollback();
    }
  }

  it('can introduce a preselected reference after the real complete table scope returns zero and releases locks', async () => {
    expect(await waitingWriter(async () => {})).toEqual({});
    expect(await source.model.count()).toBe(1);
    const row = await source.model.findByPk(2);
    expect([row.getDataValue('path'), row.getDataValue('filename'), row.getDataValue('storageId')]).toEqual([
      'nested',
      'retained.txt',
      18,
    ]);
  });

  it('does not make a newly inserted tombstone visible to a lookup guard in an older repeatable-read writer', async () => {
    await installCandidate('lookup');
    expect(await waitingWriter((tx) => query('INSERT INTO writer_gate VALUES (1, true)', tx))).toEqual({});
    expect(await source.model.count()).toBe(1);
    const [rows] = await query('SELECT reserved FROM writer_gate WHERE id=1');
    expect(rows).toEqual([{ reserved: true }]);
  });

  it('also misses an updated permanent reservation when the guard only reads the older snapshot', async () => {
    await query('INSERT INTO writer_gate VALUES (1, false)');
    await installCandidate('lookup');
    expect(await waitingWriter((tx) => query('UPDATE writer_gate SET reserved=true WHERE id=1', tx))).toEqual({});
    expect(await source.model.count()).toBe(1);
  });

  it('rejects the older snapshot with a serialization error when every writer updates a permanent gate row', async () => {
    await query('INSERT INTO writer_gate VALUES (1, false)');
    await installCandidate('write-existing');
    const result = await waitingWriter((tx) => query('UPDATE writer_gate SET reserved=true WHERE id=1', tx));
    expect(result.error?.parent?.code).toBe('40001');
    expect(await source.model.count()).toBe(0);
  });

  it('rejects a waiting read-committed writer with the current permanent reservation', async () => {
    await query('INSERT INTO writer_gate VALUES (1, false)');
    await installCandidate('write-existing');
    const result = await waitingWriter(
      (tx) => query('UPDATE writer_gate SET reserved=true WHERE id=1', tx),
      Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    );
    expect(result.error?.parent?.code).toBe('P0001');
    expect(result.error?.message).toContain('fixture gate reserved');
    expect(await source.model.count()).toBe(0);
  });

  it('rejects a missing permanent gate instead of interpreting no matching row as unreserved', async () => {
    await installCandidate('write-existing');
    await expect(mapped.repository.create({ values })).rejects.toThrow('fixture gate missing');
    expect(await source.model.count()).toBe(0);
  });

  it('can reintroduce an old client location after a reservation is cleared, even with the updating guard', async () => {
    await query('INSERT INTO writer_gate VALUES (1, false)');
    await installCandidate('write-existing');
    const preselected = { ...values };
    await query('UPDATE writer_gate SET reserved=true WHERE id=1');
    await expect(mapped.repository.create({ values: preselected })).rejects.toThrow('fixture gate reserved');
    await query('UPDATE writer_gate SET reserved=false WHERE id=1');
    await mapped.repository.create({ values: preselected });
    expect(await source.model.count()).toBe(1);
  });
});
