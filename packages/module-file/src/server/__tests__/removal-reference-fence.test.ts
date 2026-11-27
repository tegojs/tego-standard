import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, type Collection, type Database } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const operationId = '60000000-0000-4000-8000-000000000001';

describe.skipIf(!postgresUrl)('explicit PostgreSQL removal reference write fence', () => {
  let db: Database;
  let source: Collection;
  let other: Collection;
  let storages: Collection;
  let journal: Collection;
  let fence: files.AttachmentRemovalReferenceWriteFence;
  const values = { id: 2, path: '', filename: 'keep.txt', storageId: 18 };

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    const define = (name: string) =>
      db.collection({
        name,
        template: 'file',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'path', type: 'string' },
          { name: 'filename', type: 'string' },
          { name: 'storageId', type: 'integer' },
        ],
      });
    source = define('fence_files');
    other = define('fence_other_files');
    storages = db.collection({
      name: 'storages',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'type', type: 'string' },
        { name: 'options', type: 'jsonb' },
      ],
    });
    journal = db.collection({
      name: 'fence_journal',
      schema: 'public',
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'payload', type: 'jsonb' },
      ],
    });
    await db.sync();
    await storages.repository.create({ values: { id: 18, type: 'local', options: { documentRoot: 'unused' } } });
    await source.repository.create({ values });
    fence = new files.AttachmentRemovalReferenceWriteFence(db, [source, other], storages, journal);
  });

  afterEach(async () => {
    try {
      if (fence) await db.sequelize.query(`DROP FUNCTION IF EXISTS ${fence.functionName}() CASCADE`);
      await db.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  const transaction = () => db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
  const owned = async <T>(callback: (tx: Transaction) => Promise<T>) => {
    const tx = await transaction();
    try {
      const result = await callback(tx);
      await tx.commit();
      return result;
    } finally {
      if (!tx.finished) await tx.rollback();
    }
  };
  const install = () => owned((tx) => fence.install(tx));
  const reserve = () => owned((tx) => fence.reserve(operationId, tx));

  it('does no installation on construction and permits normal Repository writes after explicit open installation', async () => {
    expect(await journal.model.count()).toBe(0);
    await install();
    await other.repository.create({ values });
    await source.repository.update({ filterByTk: 2, values: { filename: 'changed.txt' } });
    await storages.repository.update({ filterByTk: 18, values: { options: { documentRoot: 'different' } } });
    await owned((tx) => fence.assertInstalled(tx));
    expect(await source.model.count()).toBe(1);
    expect(await other.model.count()).toBe(1);
  });

  it.each([
    ['source insert', "INSERT INTO fence_files VALUES (3, '', 'keep.txt', 18)"],
    ['other insert', "INSERT INTO fence_other_files VALUES (3, '', 'keep.txt', 18)"],
    ['source update', "UPDATE fence_files SET filename='new.txt' WHERE id=2"],
    ['source delete', 'DELETE FROM fence_files WHERE id=2'],
    ['source truncate', 'TRUNCATE fence_files'],
    ['storage insert', "INSERT INTO storages VALUES (19, 'local', '{}')"],
    ['storage update', "UPDATE storages SET options='{}' WHERE id=18"],
    ['storage delete', 'DELETE FROM storages WHERE id=18'],
    ['storage truncate', 'TRUNCATE storages'],
  ])('durably rejects actual %s after the reservation transaction commits', async (_name, sql) => {
    await install();
    expect(await reserve()).toEqual({ state: 'reference-writes-fenced-in-transaction', operationId });
    await expect(db.sequelize.query(sql)).rejects.toThrow('Attachment removal reference writes are fenced');
    await owned((tx) => fence.assertInstalled(tx));
    expect(await source.model.count()).toBe(1);
    expect(await other.model.count()).toBe(0);
    expect(await storages.model.count()).toBe(1);
  });

  it('keeps the original open state when reservation rolls back', async () => {
    await install();
    const tx = await transaction();
    try {
      await fence.reserve(operationId, tx);
    } finally {
      await tx.rollback();
    }
    await other.repository.create({ values });
    expect(await other.model.count()).toBe(1);
  });

  it('refuses replacing an existing reservation with another UUID or reinstalling it open', async () => {
    await install();
    await reserve();
    await expect(owned((tx) => fence.reserve('60000000-0000-4000-8000-000000000002', tx))).rejects.toThrow(
      'Removal reference fence is already reserved',
    );
    await expect(install()).rejects.toThrow();
    await expect(other.repository.create({ values })).rejects.toThrow('Attachment removal reference writes are fenced');
  });

  it.each(['missing', 'malformed'])('fails closed when the permanent row is %s', async (change) => {
    await install();
    if (change === 'missing') await journal.model.destroy({ where: {} });
    else await journal.model.update({ payload: {} }, { where: {} });
    await expect(other.repository.create({ values })).rejects.toThrow('Attachment removal reference writes are fenced');
    await expect(owned((tx) => fence.assertInstalled(tx))).rejects.toThrow('Removal reference fence state is invalid');
  });

  it('requires the complete registered reference scope and rejects newly registered files before reserving', async () => {
    await install();
    db.collection({ ...source.options, name: 'late_fence_files' });
    await expect(reserve()).rejects.toThrow(
      'Removal reference scope requires every registered file collection exactly once',
    );
  });

  it('refuses a disabled trigger, including a guard that still exists in the catalog', async () => {
    await install();
    await db.sequelize.query('ALTER TABLE fence_other_files DISABLE TRIGGER ALL');
    await expect(reserve()).rejects.toThrow('Removal reference fence installation changed');
  });

  it('does not leave a function, trigger or permanent row after installation rollback', async () => {
    const tx = await transaction();
    try {
      await fence.install(tx);
    } finally {
      await tx.rollback();
    }
    expect(await journal.model.count()).toBe(0);
    await expect(owned((tx) => fence.assertInstalled(tx))).rejects.toThrow(
      'Removal reference fence installation changed',
    );
    await other.repository.create({ values });
  });

  it('rejects an operation UUID with a trailing newline rather than persisting it as a reservation', async () => {
    await install();
    await expect(owned((tx) => fence.reserve(`${operationId}\n`, tx))).rejects.toThrow(
      'Removal reference fence requires a valid operation UUID',
    );
    await other.repository.create({ values });
  });

  it('refuses a malformed persisted reservation even if its first line is a UUID', async () => {
    await install();
    const row = await journal.model.findOne();
    const payload = row.getDataValue('payload');
    await journal.model.update({ payload: { ...payload, reservation: `${operationId}\n` } }, { where: {} });
    await expect(owned((tx) => fence.assertInstalled(tx))).rejects.toThrow('Removal reference fence state is invalid');
  });

  it('verifies the committed reservation from a fresh pool and fresh mappings without private handles', async () => {
    await install();
    await reserve();
    const observer = isolatedPostgresDatabase(postgresUrl!);
    try {
      const observerSource = observer.collection({ ...source.options });
      const observerOther = observer.collection({ ...other.options });
      const observerStorages = observer.collection({ ...storages.options });
      const observerJournal = observer.collection({ ...journal.options });
      const independent = new files.AttachmentRemovalReferenceWriteFence(
        observer,
        [observerOther, observerSource],
        observerStorages,
        observerJournal,
      );
      const tx = await observer.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
      try {
        await independent.assertInstalled(tx);
      } finally {
        await tx.rollback();
      }
      await expect(observerOther.repository.create({ values })).rejects.toThrow(
        'Attachment removal reference writes are fenced',
      );
    } finally {
      await observer.close();
    }
  });

  it('rejects altered function security rather than treating the trigger name as installation proof', async () => {
    await install();
    await db.sequelize.query(`ALTER FUNCTION ${fence.functionName}() SECURITY DEFINER`);
    await expect(reserve()).rejects.toThrow('Removal reference fence installation changed');
  });

  it('preserves dollar tokens in actual journal table and field identifiers without bind-text rewriting', async () => {
    const dollar = db.collection({
      name: 'dollar_fence_journal',
      tableName: 'fence$payload_journal',
      schema: 'public',
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true, field: '$key' },
        { name: 'payload', type: 'jsonb', field: '$payload' },
      ],
    });
    await dollar.model.sync();
    fence = new files.AttachmentRemovalReferenceWriteFence(db, [source, other], storages, dollar);
    await install();
    await reserve();
    await owned((tx) => fence.assertInstalled(tx));
    await expect(other.repository.create({ values })).rejects.toThrow('Attachment removal reference writes are fenced');
  });

  it.each(['rls', 'constraint'])('rejects unsupported journal behavior: %s', async (change) => {
    await install();
    await db.sequelize.query(
      change === 'rls'
        ? 'ALTER TABLE fence_journal ENABLE ROW LEVEL SECURITY'
        : 'ALTER TABLE fence_journal ADD CHECK (payload IS NOT NULL)',
    );
    await expect(reserve()).rejects.toThrow('Removal reference fence journal has unsupported physical behavior');
  });

  it.each([
    [Transaction.ISOLATION_LEVELS.REPEATABLE_READ, '40001'],
    [Transaction.ISOLATION_LEVELS.SERIALIZABLE, '40001'],
    [Transaction.ISOLATION_LEVELS.READ_COMMITTED, 'P0001'],
  ])('rejects a preselected waiting %s writer after the real reserve commits', async (isolationLevel, code) => {
    await install();
    const writer = isolatedPostgresDatabase(postgresUrl!);
    const mapped = writer.collection({ ...other.options });
    const write = await writer.sequelize.transaction({ isolationLevel });
    let tx: Transaction | undefined;
    let insertion: Promise<{ error?: { parent?: { code?: string } } }> | undefined;
    try {
      const [pids] = await writer.sequelize.query('SELECT pg_backend_pid() AS pid', { transaction: write });
      tx = await transaction();
      await fence.reserve(operationId, tx);
      insertion = mapped.repository.create({ values, transaction: write }).then(
        () => ({}),
        (error) => ({ error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [rows] = await db.sequelize.query(
          "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=$pid",
          { bind: { pid: (pids as { pid: number }[])[0].pid } },
        );
        if ((rows as { blocked: boolean }[])[0]?.blocked) {
          blocked = true;
          break;
        }
        await delay(20);
      }
      expect(blocked).toBe(true);
      await tx.commit();
      expect((await insertion).error?.parent?.code).toBe(code);
      expect(await other.model.count()).toBe(0);
    } finally {
      if (tx && !tx.finished) await tx.rollback();
      await insertion;
      if (!write.finished) await write.rollback();
      await writer.close();
    }
  });
});
