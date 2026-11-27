import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, type Collection, type Database } from '@tego/server';

import {
  isolatedPostgresDatabase,
  sqliteDatabase,
} from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { getLocalStorageRoot } from '../storages/local-root';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Dependency characterization for the next reference guard. These queries are deliberately
// incomplete candidates, not production reference checks or permission to remove file bytes.
describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'local removal reference boundaries (%s)',
  (dialect) => {
    let db: Database;
    let source: Collection;
    let other: Collection;
    let storages: Collection;
    let directory: string;
    let root: string;
    let filename: string;
    const record = { id: 2, tenantId: 'H', path: 'nested', filename: 'receipt.txt', storageId: 18, size: 4 };

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-reference-'));
      root = path.join(directory, 'root');
      filename = path.join(root, 'nested', 'receipt.txt');
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, 'keep');
      db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
      storages = db.collection({
        name: 'reference_storages',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'options', type: 'jsonb' },
        ],
      });
      const defineFiles = (name: string) =>
        db.collection({
          name,
          template: 'file',
          paranoid: true,
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            ...['tenantId', 'path', 'filename'].map((name) => ({ name, type: 'string' })),
            { name: 'storageId', type: 'integer' },
            { name: 'size', type: 'integer' },
          ],
        });
      source = defineFiles('reference_files');
      other = defineFiles('reference_other_files');
      await db.sync();
      await storages.model.bulkCreate([
        { id: 18, options: { documentRoot: root } },
        { id: 19, options: { documentRoot: root } },
        { id: 20, options: { documentRoot: path.join(root, 'nested') } },
        { id: 21, options: { documentRoot: path.join(directory, 'elsewhere') } },
      ]);
    });

    afterEach(async () => {
      try {
        if (dialect === 'postgres') await db.sequelize.drop({ cascade: true });
      } finally {
        await db?.close();
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      }
    });

    async function resolvedLocation(values: typeof record) {
      const storage = await storages.model.findByPk(values.storageId);
      const configuredRoot = getLocalStorageRoot({ options: storage.getDataValue('options') });
      return path.join(await fs.realpath(configuredRoot), values.path, values.filename);
    }

    async function expectSameObject(candidate: string) {
      const original = await fs.lstat(filename, { bigint: true });
      const actual = await fs.lstat(candidate, { bigint: true });
      expect([actual.dev, actual.ino, actual.birthtimeNs]).toEqual([original.dev, original.ino, original.birthtimeNs]);
      expect(actual.ino > 0n).toBe(true);
      expect(await fs.readFile(filename, 'utf8')).toBe('keep');
    }

    it('can reference the same object through another storage id despite an empty original-storage query', async () => {
      const values = { ...record, storageId: 19 };
      await source.repository.create({ values });
      expect(await source.model.count({ where: { storageId: 18, path: record.path, filename: record.filename } })).toBe(
        0,
      );
      expect(await source.model.count()).toBe(1);
      await expectSameObject(await resolvedLocation(values));
    });

    it('can reference the same object from a nested storage root with a different stored relative path', async () => {
      const values = { ...record, storageId: 20, path: '' };
      await source.repository.create({ values });
      expect(await source.model.count({ where: { path: record.path, filename: record.filename } })).toBe(0);
      await expectSameObject(await resolvedLocation(values));
    });

    it('keeps references in another collection and outside the actor scope relevant to object retention', async () => {
      await other.repository.create({ values: record });
      other.model.addScope('actor', { where: { tenantId: 'B' } });
      expect(await source.model.count()).toBe(0);
      expect(await other.model.scope('actor').count()).toBe(0);
      expect(await other.model.unscoped().count({ paranoid: false })).toBe(1);
      await expectSameObject(await resolvedLocation(record));
    });

    it('does not remove the paranoid filter merely by using an unscoped model', async () => {
      await source.repository.create({ values: record });
      await source.repository.destroy({ filterByTk: record.id });
      expect(await source.model.unscoped().count()).toBe(0);
      const retained = await source.model.unscoped().findByPk(record.id, { paranoid: false });
      expect(retained.getDataValue('deletedAt')).toBeTruthy();
      expect(await source.model.unscoped().count({ paranoid: false })).toBe(1);
      await expectSameObject(await resolvedLocation(record));
    });

    it('does not equate equal relative names in disjoint roots with the same filesystem object', async () => {
      const values = { ...record, storageId: 21 };
      const separate = path.join(directory, 'elsewhere', values.path, values.filename);
      await fs.mkdir(path.dirname(separate), { recursive: true });
      await fs.writeFile(separate, 'keep');
      await source.repository.create({ values });
      expect(await source.model.count({ where: { path: record.path, filename: record.filename } })).toBe(1);
      const original = await fs.lstat(filename, { bigint: true });
      const distinct = await fs.lstat(await resolvedLocation(values), { bigint: true });
      expect([distinct.dev, distinct.ino, distinct.birthtimeNs]).not.toEqual([
        original.dev,
        original.ino,
        original.birthtimeNs,
      ]);
      expect(await fs.readFile(filename, 'utf8')).toBe('keep');
    });

    describe.skipIf(dialect !== 'postgres')('PostgreSQL reference write coordination', () => {
      it('does not protect storage root changes merely by locking every mapped file table', async () => {
        await source.repository.create({ values: record });
        const reader = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
        const writer = isolatedPostgresDatabase(postgresUrl!);
        try {
          const mapped = writer.collection({ ...storages.options });
          await db.sequelize.query('LOCK TABLE reference_files, reference_other_files IN SHARE MODE', {
            transaction: reader,
          });
          const before = await storages.model.findByPk(18, { transaction: reader });
          expect(before.getDataValue('options').documentRoot).toBe(root);
          await mapped.model.update(
            { options: { documentRoot: path.join(directory, 'elsewhere') } },
            { where: { id: 18 } },
          );
          const current = await mapped.model.findByPk(18);
          expect(current.getDataValue('options').documentRoot).toBe(path.join(directory, 'elsewhere'));
          expect(await fs.readFile(filename, 'utf8')).toBe('keep');
        } finally {
          await reader.rollback();
          await writer.close();
        }
      });

      it('does not block an insert into another reference source when only the original source is locked', async () => {
        const reader = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
        const writer = isolatedPostgresDatabase(postgresUrl!);
        try {
          const mapped = writer.collection({ ...other.options });
          await db.sequelize.query('LOCK TABLE reference_files IN SHARE MODE', { transaction: reader });
          expect(await source.model.count({ transaction: reader })).toBe(0);
          await mapped.repository.create({ values: record });
          expect(await mapped.model.count()).toBe(1);
          await expectSameObject(await resolvedLocation(record));
        } finally {
          await reader.rollback();
          await writer.close();
        }
      });

      it('blocks an ordinary insert when the actual additional reference table is also locked', async () => {
        const reader = await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
        const writer = isolatedPostgresDatabase(postgresUrl!);
        const writeTransaction = await writer.sequelize.transaction();
        let insertion: Promise<unknown> | undefined;
        try {
          const mapped = writer.collection({ ...other.options });
          const [pidRows] = await writer.sequelize.query('SELECT pg_backend_pid() AS pid', {
            transaction: writeTransaction,
          });
          const pid = (pidRows as { pid: number }[])[0].pid;
          await db.sequelize.query('LOCK TABLE reference_files, reference_other_files IN SHARE MODE', {
            transaction: reader,
          });
          insertion = mapped.repository.create({ values: record, transaction: writeTransaction });
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
          expect(await other.model.count({ transaction: reader })).toBe(0);
          await reader.rollback();
          await insertion;
          await writeTransaction.commit();
          expect(await mapped.model.count()).toBe(1);
          await expectSameObject(await resolvedLocation(record));
        } finally {
          if (!reader.finished) await reader.rollback();
          await insertion?.catch(() => {});
          if (!writeTransaction.finished) await writeTransaction.rollback();
          await writer.close();
        }
      });
    });
  },
);
