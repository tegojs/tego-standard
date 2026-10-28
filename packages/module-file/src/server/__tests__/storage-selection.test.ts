import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockDatabase, Transaction, type Collection, type Database, type Field } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import storages from '../collections/storages';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'server-selected staged attachment storage (%s)',
  (dialect) => {
    let db: Database;
    let collection: Collection;
    let source: Collection;
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
      source = db.collection({
        name: 'sources',
        timestamps: false,
        fields: [
          { name: 'file', type: 'belongsTo', target: 'files', storage: 'receipts' },
          { name: 'files', type: 'belongsToMany', target: 'files', through: 'source_files', storage: 'receipts' },
          { name: 'wrong', type: 'string', storage: 'receipts' },
          { name: 'storage', type: 'belongsTo', target: 'storages', storage: 'receipts' },
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
        if (dialect === 'postgres')
          await db.sequelize.query('DROP TABLE IF EXISTS "source_files", "sources", "files", "storages"');
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
    async function persist(change?: (transaction: Transaction) => Promise<void>, attachmentField?: Field) {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-selected-storage-'));
      const root = path.join(directory, 'root');
      const staged = path.join(directory, 'staged');
      const bytes = Buffer.from('Selected storage bytes');
      await fs.writeFile(staged, bytes);
      await db.getRepository('storages').update({
        filter: { id: { $in: [17, 18] } },
        values: { options: { documentRoot: root } },
      });
      const selected = await files.resolveStagedAttachmentStorage(collection, attachmentField);
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

    it.each(['file', 'files'])(
      'uses the registered %s field storage before file-table/default storage',
      async (name) => {
        collection.options.storage = 'local';
        const selected = await files.resolveStagedAttachmentStorage(collection, source.getField(name));
        transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
        expect(selected.values).toMatchObject({ id: 18, name: 'receipts', rules: { size: 1024 } });
        await expect(selected.assertCurrent(transaction)).resolves.toBeUndefined();
      },
    );

    it('falls back to the file-table setting then the unique default only when the field has no override', async () => {
      delete source.getField('file').options.storage;
      collection.options.storage = 'receipts';
      expect((await files.resolveStagedAttachmentStorage(collection, source.getField('file'))).values.id).toBe(18);
      delete collection.options.storage;
      expect((await files.resolveStagedAttachmentStorage(collection, source.getField('file'))).values.id).toBe(17);
    });

    it.each(['missing', '', null, 17])(
      'rejects an invalid explicit field storage %s rather than falling back',
      async (value) => {
        source.getField('file').options.storage = value;
        await expect(files.resolveStagedAttachmentStorage(collection, source.getField('file'))).rejects.toThrow();
      },
    );

    it.each(['wrong', 'storage'])(
      'rejects field %s which is not an actual relation to this file table',
      async (name) => {
        await expect(files.resolveStagedAttachmentStorage(collection, source.getField(name))).rejects.toThrow();
      },
    );

    it('rejects a same-named attachment field from another database', async () => {
      const other = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
      try {
        other.collection({ name: 'files' });
        const foreign = other.collection({
          name: 'sources',
          fields: [{ name: 'file', type: 'belongsTo', target: 'files', storage: 'receipts' }],
        });
        await expect(files.resolveStagedAttachmentStorage(collection, foreign.getField('file'))).rejects.toThrow();
      } finally {
        await other.close();
      }
    });

    it.each(['storage', 'target'])('rejects changed attachment field %s after capture', async (key) => {
      const field = source.getField('file');
      const selected = await files.resolveStagedAttachmentStorage(collection, field);
      transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      field.options[key] = key === 'storage' ? 'local' : 'storages';
      await expect(selected.assertCurrent(transaction)).rejects.toThrow();
    });

    it('rejects removal of the selected attachment relationship', async () => {
      const selected = await files.resolveStagedAttachmentStorage(collection, source.getField('file'));
      transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      delete source.model.associations.file;
      await expect(selected.assertCurrent(transaction)).rejects.toThrow();
    });

    it('commits actual bytes with the field-selected storage rather than the default', async () => {
      const key = await persist(undefined, source.getField('file'));
      expect((await collection.model.findByPk(key)).getDataValue('storageId')).toBe(18);
      expect(await fs.readFile(destination, 'utf8')).toBe('Selected storage bytes');
    });

    it('rolls back the actual row and bytes if the field override changes after copy', async () => {
      await expect(
        persist(async () => {
          source.getField('file').options.storage = 'local';
        }, source.getField('file')),
      ).rejects.toThrow();
      expect(stored).toBe(true);
      expect(await collection.repository.count()).toBe(0);
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('renders server configuration once and adds the trusted tenant directory', async () => {
      const selected = await select();
      const rendered = files.renderStagedAttachmentStorage(
        selected,
        (raw) => ({
          ...raw,
          path: 'receipts',
          baseUrl: '/rendered',
          options: { documentRoot: 'private-root' },
        }),
        'B',
      );
      expect(rendered).toMatchObject({
        id: 17,
        type: 'local',
        path: 'receipts/tenants/B',
        baseUrl: '/rendered',
        options: { documentRoot: 'private-root' },
      });
      expect(selected.values.path).toBe('default');
      await expect(selected.assertCurrent(transaction)).resolves.toBeUndefined();
    });

    it('keeps a shared storage path when the trusted caller has no tenant', async () => {
      const selected = await select();
      expect(files.renderStagedAttachmentStorage(selected, (raw) => raw).path).toBe('default');
    });

    it.each(['id', 'type', 'name'])('rejects rendering that replaces selected storage %s', async (field) => {
      const selected = await select();
      expect(() =>
        files.renderStagedAttachmentStorage(
          selected,
          (raw) => {
            raw[field] = field === 'id' ? 18 : 'different';
            return raw;
          },
          'B',
        ),
      ).toThrow('Rendered attachment storage identity changed');
    });

    it('does not retain mutable rendered options supplied by the server callback', async () => {
      const selected = await select();
      const options = { documentRoot: 'original' };
      const rendered = files.renderStagedAttachmentStorage(selected, (raw) => ({ ...raw, options }), 'B');
      options.documentRoot = 'changed';
      expect(rendered.options.documentRoot).toBe('original');
    });

    it('requires synchronous server rendering and observes an accidentally rejected promise', async () => {
      const selected = await select();
      expect(() =>
        files.renderStagedAttachmentStorage(
          selected,
          async () => {
            throw new Error('asynchronous renderer failed');
          },
          'B',
        ),
      ).toThrow('Attachment storage renderer must be synchronous');
      await new Promise<void>((resolve) => setImmediate(resolve));
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

    describe('stored attachment read configuration', () => {
      async function storedSelection(key: unknown) {
        return files.resolveAttachmentReadStorage(collection, key as string | number);
      }

      it('uses the stored key independently of current table, field and default upload choices', async () => {
        collection.options.storage = 'missing-upload-storage';
        source.getField('file').options.storage = 'also-missing';
        const selected = await storedSelection('18');
        expect(selected.values).toMatchObject({ id: 18, name: 'receipts', path: 'receipts' });
        await selected.assertCurrent();
        collection.options.storage = 'local';
        await selected.assertCurrent();
      });

      it('does not fall back to the valid default when the stored key is missing', async () => {
        await expect(storedSelection(999)).rejects.toBeInstanceOf(TypeError);
      });

      it.each([undefined, null, '', [], {}, Number.NaN, 1.5, 'x'.repeat(256)])(
        'rejects invalid stored keys %j without choosing another storage',
        async (key) => {
          await expect(storedSelection(key)).rejects.toBeInstanceOf(TypeError);
        },
      );

      it('detects changed persisted storage configuration on a fresh master read', async () => {
        const selected = await storedSelection(18);
        await db.getRepository('storages').update({ filterByTk: 18, values: { path: 'new-upload-path' } });
        await expect(selected.assertCurrent()).rejects.toBeInstanceOf(TypeError);
      });

      it('does not let a consumer mutate the configuration snapshot used by the guard', async () => {
        const selected = await storedSelection(18);
        (selected.values.options as Record<string, unknown>).documentRoot = 'different';
        expect(selected.values.options).toEqual({ documentRoot: 'storage/receipts' });
        await selected.assertCurrent();
      });

      it('rejects replaced storage relation metadata before returning the configuration', async () => {
        const selected = await storedSelection(18);
        collection.model.associations.storage = source.model.associations.file;
        await expect(selected.assertCurrent()).rejects.toBeInstanceOf(TypeError);
      });

      it('uses an active read-only PostgreSQL transaction without taking an update lock', async () => {
        const selected = await storedSelection(18);
        transaction = await db.sequelize.transaction();
        if (dialect === 'postgres') await db.sequelize.query('SET TRANSACTION READ ONLY', { transaction });
        await selected.assertCurrent(transaction);
        await transaction.commit();
        await expect(selected.assertCurrent(transaction)).rejects.toBeInstanceOf(TypeError);
      });

      it('reads the historical stored path, never the new upload path or a viewer tenant directory', async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-stored-read-'));
        const root = path.join(directory, 'root');
        await fs.mkdir(path.join(root, 'old/tenants/H'), { recursive: true });
        await fs.writeFile(path.join(root, 'old/tenants/H/receipt.txt'), 'Stored under H');
        await db.getRepository('storages').update({ filterByTk: 18, values: { options: { documentRoot: root } } });
        const selected = await storedSelection(18);
        const result = await files.withLocalAttachmentRead(
          selected.values as unknown as files.StagedAttachmentStorage,
          { storageId: 18, path: 'old/tenants/H', filename: 'receipt.txt', size: 14 },
          async (handle) => {
            await selected.assertCurrent();
            return handle.readFile('utf8');
          },
        );
        expect(result).toBe('Stored under H');
        expect(await fs.readdir(root)).toEqual(['old']);
      });
    });
  },
);
