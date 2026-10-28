import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockDatabase, Transaction, type Collection, type Database } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import storages from '../collections/storages';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'server-selected staged attachment storage (%s)',
  (dialect) => {
    let db: Database;
    let collection: Collection;
    let transaction: Transaction;
    let directory: string;
    let destination: string;
    let stored: boolean;

    beforeEach(async () => {
      db =
        dialect === 'postgres'
          ? isolatedPostgresDatabase(postgresUrl)
          : mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
      db.collection(storages);
      collection = db.collection({
        name: 'files',
        template: 'file',
        timestamps: false,
        fields: [
          { name: 'storage', type: 'belongsTo', target: 'storages', foreignKey: 'storageId' },
          ...['title', 'filename', 'extname', 'path', 'url', 'mimetype'].map((name) => ({ name, type: 'string' })),
          { name: 'size', type: 'integer' },
          { name: 'meta', type: 'json' },
        ],
      });
      await db.sync();
      await db.getRepository('storages').create({
        values: [
          {
            id: 17,
            name: 'local',
            type: 'local',
            title: 'Local',
            default: true,
            path: 'default',
            baseUrl: '/files',
            options: { documentRoot: 'storage/uploads' },
          },
          {
            id: 18,
            name: 'receipts',
            type: 'local',
            title: 'Receipts',
            default: false,
            path: 'receipts',
            baseUrl: '/receipts',
            options: { documentRoot: 'storage/receipts' },
            rules: { size: 1024 },
          },
        ],
      });
      transaction = undefined;
      directory = undefined;
      stored = false;
    });
    afterEach(async () => {
      try {
        if (transaction && !(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
        if (dialect === 'postgres') await db.sequelize.query('DROP TABLE IF EXISTS "files", "storages"');
      } finally {
        await db?.close();
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      }
    });

    async function select() {
      const selected = await files.resolveStagedAttachmentStorage(collection);
      transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      return selected;
    }

    // This composition proves config/bytes/metadata coordination, not operation ACL or G.
    async function persist(change?: (transaction: Transaction) => Promise<void>) {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-selected-storage-'));
      const root = path.join(directory, 'root');
      const staged = path.join(directory, 'staged');
      const bytes = Buffer.from('Selected storage bytes');
      await fs.writeFile(staged, bytes);
      await db.getRepository('storages').update({ filterByTk: 17, values: { options: { documentRoot: root } } });
      const selected = await files.resolveStagedAttachmentStorage(collection);
      return files.withStagedAttachmentTransaction(
        db,
        selected.values as unknown as files.StagedAttachmentStorage,
        { path: staged, originalname: 'receipt.pdf', mimetype: 'application/pdf', size: bytes.length },
        async ({ transaction: owned, values, store }) => {
          await selected.assertCurrent(owned);
          const verify = files.captureStagedAttachmentRecord(collection, values);
          const record = await collection.repository.create({ values, transaction: owned });
          await store();
          destination = path.join(root, values.path, values.filename);
          stored = true;
          expect(await fs.readFile(destination)).toEqual(bytes);
          await change?.(owned);
          await selected.assertCurrent(owned);
          await verify(record.getDataValue('id'), owned);
          return record.getDataValue('id');
        },
      );
    }

    it('selects the configured storage rather than the default and verifies the actual relation', async () => {
      collection.options.storage = 'receipts';
      const selected = await select();
      expect(selected.values).toMatchObject({ id: 18, name: 'receipts', path: 'receipts', rules: { size: 1024 } });
      await expect(selected.assertCurrent(transaction)).resolves.toBeUndefined();
      expect(await db.getRepository('files').count({ transaction })).toBe(0);
    });

    it('uses the sole default only when the file table has no configured storage', async () => {
      const selected = await select();
      expect(selected.values).toMatchObject({ id: 17, name: 'local' });
    });

    it('does not fall back to default when the explicitly configured storage is missing', async () => {
      collection.options.storage = 'missing';
      await expect(select()).rejects.toThrow('unique configured storage');
    });

    it('rejects ambiguous default storage', async () => {
      // Imported/corrupt configuration can bypass the radio field's normal single-default maintenance.
      await db.sequelize.query('UPDATE "storages" SET "default" = true WHERE "id" = 18');
      await expect(select()).rejects.toThrow('unique configured storage');
    });

    it('rejects missing default storage', async () => {
      await db.getRepository('storages').update({ filterByTk: 17, values: { default: false }, transaction });
      await expect(select()).rejects.toThrow('unique configured storage');
    });

    it('keeps returned configuration independent of the captured storage selection', async () => {
      const selected = await select();
      const returned = selected.values;
      (returned.options as Record<string, unknown>).documentRoot = 'another-root';
      expect((selected.values.options as Record<string, unknown>).documentRoot).toBe('storage/uploads');
      await expect(selected.assertCurrent(transaction)).resolves.toBeUndefined();
    });

    it.each([
      ['path', 'other'],
      ['options', { documentRoot: 'another-root' }],
      ['rules', { size: 1 }],
      ['type', 's3'],
      ['baseUrl', '/changed'],
      ['default', false],
    ])('rejects changed persisted %s before storage side effects', async (field, value) => {
      const selected = await select();
      await db.getRepository('storages').update({ filterByTk: 17, values: { [field]: value }, transaction });
      await expect(selected.assertCurrent(transaction)).rejects.toThrow('Selected attachment storage changed');
    });

    it('rejects deletion of the selected storage', async () => {
      const selected = await select();
      await db.getRepository('storages').destroy({ filterByTk: 17, transaction });
      await expect(selected.assertCurrent(transaction)).rejects.toThrow('Selected attachment storage changed');
    });

    it('rejects a changed file-table storage choice', async () => {
      const selected = await select();
      collection.options.storage = 'receipts';
      await expect(selected.assertCurrent(transaction)).rejects.toThrow(
        'Attachment storage selection identity changed',
      );
    });

    it('rejects a changed storage relationship', async () => {
      const selected = await select();
      delete collection.model.associations.storage;
      await expect(selected.assertCurrent(transaction)).rejects.toThrow(
        'Attachment storage selection identity changed',
      );
    });

    it('rejects changed physical mapping of the file storage foreign key', async () => {
      const selected = await select();
      collection.model.rawAttributes.storageId.field = 'another_storage_id';
      await expect(selected.assertCurrent(transaction)).rejects.toThrow(
        'Attachment storage selection identity changed',
      );
    });

    it('rejects an ended transaction rather than falling back to an unlocked query', async () => {
      const selected = await select();
      await transaction.commit();
      await expect(selected.assertCurrent(transaction)).rejects.toThrow('active storage selection transaction');
    });

    it('does not select through an unsupported scoped storage association', async () => {
      Object.assign(collection.model.associations.storage, { scope: { type: 's3' } });
      await expect(select()).rejects.toThrow('Attachment storage selection identity changed');
    });

    it('rejects initial selection for a non-file table', async () => {
      collection.options.template = 'general';
      await expect(select()).rejects.toThrow('Attachment storage selection identity changed');
    });

    it('does not let a storage default scope or getter replace the persisted selection', async () => {
      const storage = db.getCollection('storages');
      storage.setField('path', { type: 'string', get: () => 'forged-display-path' });
      storage.model.addScope('defaultScope', { where: { id: 18 } }, { override: true });
      const selected = await select();
      expect(selected.values).toMatchObject({ id: 17, path: 'default' });
      await expect(selected.assertCurrent(transaction)).resolves.toBeUndefined();
    });

    it('rejects selection verification in a different database transaction', async () => {
      const selected = await select();
      const other = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
      const otherTransaction = await other.sequelize.transaction();
      try {
        await expect(selected.assertCurrent(otherTransaction)).rejects.toThrow('active storage selection transaction');
      } finally {
        await otherTransaction.rollback();
        await other.close();
      }
    });

    it('commits actual bytes and a file record referencing the server-selected storage', async () => {
      const key = await persist();
      const record = await collection.model.findByPk(key);
      expect(record.getDataValue('storageId')).toBe(17);
      expect(stored).toBe(true);
      expect(await fs.readFile(destination, 'utf8')).toBe('Selected storage bytes');
    });

    it('rolls back row, config change and stored bytes when configuration changes after copy', async () => {
      await expect(
        persist(async (owned) => {
          await db
            .getRepository('storages')
            .update({ filterByTk: 17, values: { path: 'changed' }, transaction: owned });
        }),
      ).rejects.toThrow('Selected attachment storage changed');
      expect(stored).toBe(true);
      expect(await collection.repository.count()).toBe(0);
      expect((await db.getRepository('storages').findOne({ filterByTk: 17 })).getDataValue('path')).toBe('default');
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rolls back bytes when a real insert hook changes the actual storage relation', async () => {
      db.on('files.beforeCreate', (record) => record.setDataValue('storageId', 18));
      await expect(persist()).rejects.toThrow('Persisted attachment storage metadata changed');
      expect(stored).toBe(true);
      expect(await collection.repository.count()).toBe(0);
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);
