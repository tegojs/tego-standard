import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, type Collection, type Database } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('explicit PostgreSQL removal reference scope', () => {
  let db: Database;
  let source: Collection;
  let other: Collection;
  let storages: Collection;

  const defineSource = (name: string) =>
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

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    source = defineSource('scope_files');
    other = defineSource('scope_other_files');
    storages = db.collection({
      name: 'storages',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'type', type: 'string' },
        { name: 'options', type: 'jsonb' },
      ],
    });
    await db.sync();
    await storages.repository.create({ values: { id: 18, type: 'local', options: { documentRoot: 'original' } } });
  });

  afterEach(async () => {
    try {
      await db.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  const transaction = () => db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
  const lock = (tx: Transaction, sources: readonly Collection[] = [source, other]) =>
    files.lockAttachmentRemovalReferenceScope(db, sources, storages, tx);

  it('returns frozen physical source and storage identities and checks the original transaction lifecycle', async () => {
    const tx = await transaction();
    let assertCurrent: () => Promise<void>;
    try {
      const scope = await lock(tx);
      assertCurrent = scope.assertCurrent;
      expect(scope.sources.map((entry) => entry.collectionName).sort()).toEqual(['scope_files', 'scope_other_files']);
      expect(scope.sources[0]).toMatchObject({
        schema: 'public',
        fields: { path: 'path', filename: 'filename', storageId: 'storageId' },
      });
      expect(scope.storage).toMatchObject({
        collectionName: 'storages',
        schema: 'public',
        fields: { id: 'id', type: 'type', options: 'options' },
      });
      expect(new Set([...scope.sources, scope.storage].map((entry) => entry.oid)).size).toBe(3);
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Object.isFrozen(scope.sources)).toBe(true);
      expect(Object.isFrozen(scope.sources[0].fields)).toBe(true);
      await scope.assertCurrent();
    } finally {
      await tx.rollback();
    }
    await expect(assertCurrent()).rejects.toThrow(
      'Removal reference scope requires its active serializable transaction',
    );
  });

  it.each(['missing', 'duplicate'])('rejects an incomplete or duplicated registered file scope: %s', async (change) => {
    const tx = await transaction();
    try {
      await expect(lock(tx, change === 'missing' ? [source] : [source, other, source])).rejects.toThrow(
        'Removal reference scope requires every registered file collection exactly once',
      );
    } finally {
      await tx.rollback();
    }
  });

  it('rejects a file collection registered after the scope was acquired', async () => {
    const tx = await transaction();
    try {
      const scope = await lock(tx);
      defineSource('late_files');
      await expect(scope.assertCurrent()).rejects.toThrow('Removal reference scope metadata changed');
    } finally {
      await tx.rollback();
    }
  });

  it('rejects a changed physical field mapping after the scope was acquired', async () => {
    const tx = await transaction();
    const attribute = source.model.rawAttributes.path;
    const original = attribute.field;
    try {
      const scope = await lock(tx);
      attribute.field = 'another_path';
      await expect(scope.assertCurrent()).rejects.toThrow('Removal reference scope metadata changed');
    } finally {
      attribute.field = original;
      await tx.rollback();
    }
  });

  it('rejects a read committed transaction rather than trusting a point read to coordinate references', async () => {
    const tx = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED });
    try {
      await expect(lock(tx)).rejects.toThrow('Removal reference scope requires its active serializable transaction');
    } finally {
      await tx.rollback();
    }
  });

  it('rejects a transaction from another pool for the same database', async () => {
    const foreign = isolatedPostgresDatabase(postgresUrl!);
    const tx = await foreign.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
    try {
      await expect(lock(tx)).rejects.toThrow('Removal reference scope requires its active serializable transaction');
    } finally {
      await tx.rollback();
      await foreign.close();
    }
  });

  it('rejects a nested transaction', async () => {
    const parent = await transaction();
    const nested = await db.sequelize.transaction({ transaction: parent });
    try {
      await expect(lock(nested)).rejects.toThrow(
        'Removal reference scope requires its active serializable transaction',
      );
    } finally {
      await nested.rollback();
      await parent.rollback();
    }
  });

  it.each(['scope_files', 'storages'])('rejects RLS on a required physical table: %s', async (table) => {
    await db.sequelize.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    const tx = await transaction();
    try {
      await expect(lock(tx)).rejects.toThrow('Removal reference scope has unsupported physical tables');
    } finally {
      await tx.rollback();
    }
  });

  it('rejects an inherited reference table', async () => {
    await db.sequelize.query('CREATE TABLE inherited_scope_files () INHERITS (scope_files)');
    const tx = await transaction();
    try {
      await expect(lock(tx)).rejects.toThrow('Removal reference scope has unsupported physical tables');
    } finally {
      await tx.rollback();
    }
  });

  it('rejects missing actual location columns rather than quoting metadata for a different column', async () => {
    await db.sequelize.query('ALTER TABLE scope_files RENAME COLUMN path TO different_path');
    const tx = await transaction();
    try {
      await expect(lock(tx)).rejects.toThrow('Removal reference scope has unsupported physical tables');
    } finally {
      await tx.rollback();
    }
  });

  it('rejects an incompatible actual location column type with unchanged model metadata', async () => {
    await db.sequelize.query('ALTER TABLE scope_files ALTER COLUMN path TYPE integer USING NULL');
    const tx = await transaction();
    try {
      await expect(lock(tx)).rejects.toThrow('Removal reference scope has unsupported physical tables');
    } finally {
      await tx.rollback();
    }
  });

  it.each(['reference insert', 'storage update'])(
    'blocks an ordinary independent writer until the original transaction ends: %s',
    async (operation) => {
      const tx = await transaction();
      const writer = isolatedPostgresDatabase(postgresUrl!);
      const writeTx = await writer.sequelize.transaction();
      let pending: Promise<unknown> | undefined;
      try {
        await lock(tx);
        const [pids] = await writer.sequelize.query('SELECT pg_backend_pid() AS pid', { transaction: writeTx });
        const pid = (pids as { pid: number }[])[0].pid;
        const mapped = writer.collection({ ...(operation === 'reference insert' ? other : storages).options });
        pending =
          operation === 'reference insert'
            ? mapped.repository.create({
                values: { id: 2, path: '', filename: 'keep.txt', storageId: 18 },
                transaction: writeTx,
              })
            : mapped.model.update(
                { options: { documentRoot: 'changed' } },
                { where: { id: 18 }, transaction: writeTx },
              );
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [rows] = await db.sequelize.query(
            "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=$pid",
            { bind: { pid } },
          );
          if ((rows as { blocked: boolean }[])[0]?.blocked) {
            blocked = true;
            break;
          }
          await delay(20);
        }
        expect(blocked).toBe(true);
        await tx.rollback();
        await pending;
        await writeTx.commit();
        if (operation === 'reference insert') expect(await mapped.model.count()).toBe(1);
        else expect((await mapped.model.findByPk(18)).getDataValue('options')).toEqual({ documentRoot: 'changed' });
      } finally {
        if (!tx.finished) await tx.rollback();
        await pending?.catch(() => {});
        if (!writeTx.finished) await writeTx.rollback();
        await writer.close();
      }
    },
  );
});
