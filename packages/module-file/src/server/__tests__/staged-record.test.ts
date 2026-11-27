import { mockDatabase, Transaction, type Collection, type Database } from '@tego/server';

import { captureStagedAttachmentRecord, captureStagedAttachmentResponse, type StagedAttachmentStorageValues } from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { FileModel } from '../FileModel';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'staged attachment final record checks (%s)',
  (dialect) => {
    let db: Database;
    let collection: Collection;
    let transaction: Transaction;
    let values: StagedAttachmentStorageValues;

    beforeEach(async () => {
      db =
        dialect === 'postgres'
          ? isolatedPostgresDatabase(postgresUrl)
          : mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
      db.registerModels({ FileModel });
      collection = db.collection({
        name: 'files',
        model: 'FileModel',
        template: 'file',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'title', type: 'string' },
          { name: 'filename', type: 'string', field: 'file_name' },
          { name: 'extname', type: 'string' },
          { name: 'path', type: 'string' },
          { name: 'url', type: 'string' },
          { name: 'mimetype', type: 'string' },
          { name: 'size', type: 'integer' },
          { name: 'meta', type: 'json' },
          { name: 'storageId', type: 'bigInt', field: 'storage_id' },
          { name: 'internalToken', type: 'string', defaultValue: 'server-secret' },
        ],
      });
      await db.sync();
      values = {
        title: 'Receipt',
        filename: 'server.pdf',
        extname: '.pdf',
        path: 'B',
        url: '/files/B/server.pdf',
        mimetype: 'application/pdf',
        size: 9,
        meta: { width: 100, nested: { valid: true } },
        storageId: 17,
      };
      transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      await collection.repository.create({ values: { id: 1, ...values }, transaction });
    });
    afterEach(async () => {
      try {
        if (transaction && !(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
        if (dialect === 'postgres') await db.sequelize.query('DROP TABLE IF EXISTS "files"');
      } finally {
        await db?.close();
      }
    });

    it('reads actual mapped columns with JSON decoding, bypassing presentation getters and default scope', async () => {
      collection.setField('filename', { type: 'string', field: 'file_name', get: () => 'presentation-only' });
      collection.model.addScope('defaultScope', { where: { id: 999 } }, { override: true });
      db.on('files.beforeFind', () => {
        throw new Error('query hook must not run');
      });
      const verify = captureStagedAttachmentRecord(collection, values);
      await expect(verify(1, transaction)).resolves.toBeUndefined();
    });

    it('allows an independently authorized title edit without changing managed metadata', async () => {
      const verify = captureStagedAttachmentRecord(collection, values);
      await collection.model.update({ title: 'Renamed' }, { where: { id: 1 }, transaction });
      await expect(verify(1, transaction)).resolves.toBeUndefined();
      expect((await collection.model.findByPk(1, { transaction })).getDataValue('title')).toBe('Renamed');
    });

    it('returns a bounded upload response with the actual persisted title and primary key', async () => {
      const read = captureStagedAttachmentResponse(collection, values);
      await collection.model.update({ title: 'Renamed' }, { where: { id: 1 }, transaction });
      collection.model.addScope('defaultScope', { where: { id: 999 } }, { override: true });
      const response = await read(1, transaction);
      expect(response).toEqual({ id: 1, ...values, title: 'Renamed', storageId: expect.anything() });
      expect(String(response.storageId)).toBe('17');
      expect(response).not.toHaveProperty('internalToken');
    });

    it('does not return presentation getters as persisted upload response fields', async () => {
      collection.setField('title', { type: 'string', get: () => 'not-persisted' });
      const read = captureStagedAttachmentResponse(collection, values);
      expect((await read(1, transaction)).title).toBe('Receipt');
    });

    it('rejects changed storage metadata instead of returning a success-shaped upload response', async () => {
      const read = captureStagedAttachmentResponse(collection, values);
      await collection.model.update({ filename: 'changed.pdf' }, { where: { id: 1 }, transaction });
      await expect(read(1, transaction)).rejects.toThrow('Persisted attachment storage metadata changed');
    });

    it('captures title column identity before upload response reads', async () => {
      const read = captureStagedAttachmentResponse(collection, values);
      collection.model.rawAttributes.title.field = 'another_title';
      await expect(read(1, transaction)).rejects.toThrow('Attachment storage record identity changed');
    });

    it('uses only captured server presentation settings without returning storage secrets', async () => {
      const previous = process.env.APP_PUBLIC_PATH;
      process.env.APP_PUBLIC_PATH = '/app/';
      try {
        const storage = {
          id: 17,
          type: 'local',
          options: { thumbnailRule: '?width=94', documentRoot: 'private-root' },
        };
        const read = captureStagedAttachmentResponse(collection, values, storage);
        storage.options.thumbnailRule = '?changed';
        process.env.APP_PUBLIC_PATH = '/changed';
        const response = await read(1, transaction);
        expect(response.url).toBe('/app/files/B/server.pdf');
        expect(response.thumbnailRule).toBe('?width=94');
        expect(response).not.toHaveProperty('options');
        expect(response).not.toHaveProperty('documentRoot');
      } finally {
        if (previous === undefined) delete process.env.APP_PUBLIC_PATH;
        else process.env.APP_PUBLIC_PATH = previous;
      }
    });

    it('does not borrow presentation from another selected storage', () => {
      expect(() => captureStagedAttachmentResponse(collection, values, { id: 18, type: 'local', options: {} })).toThrow(
        'Attachment response storage does not match',
      );
    });

    it.each([
      { type: 'local', options: {}, url: '/app/files/B/server.pdf', thumbnailRule: undefined },
      {
        type: 'ali-oss',
        options: {},
        url: '/files/B/server.pdf',
        thumbnailRule: '?x-oss-process=image/auto-orient,1/resize,m_fill,w_94,h_94/quality,q_90',
      },
      { type: 'ali-oss', options: { thumbnailRule: '?custom' }, url: '/files/B/server.pdf', thumbnailRule: '?custom' },
    ])('preserves existing FileModel presentation for $type and $options', async (example) => {
      const previous = process.env.APP_PUBLIC_PATH;
      process.env.APP_PUBLIC_PATH = '/app/';
      try {
        const row = await collection.model.findByPk(1, { transaction });
        const storage = { id: 17, type: example.type, options: example.options };
        db['_fileStorages'] = new Map([[row.getDataValue('storageId'), storage]]);
        const json = row.toJSON();
        const response = await captureStagedAttachmentResponse(collection, values, storage)(1, transaction);
        for (const result of [json, response]) {
          expect(result.url).toBe(example.url);
          expect(result.thumbnailRule).toBe(example.thumbnailRule);
        }
      } finally {
        if (previous === undefined) delete process.env.APP_PUBLIC_PATH;
        else process.env.APP_PUBLIC_PATH = previous;
      }
    });

    it('keeps its expected metadata independent from later input mutation', async () => {
      const verify = captureStagedAttachmentRecord(collection, values);
      (values.meta.nested as { valid: boolean }).valid = false;
      await collection.model.update({ meta: values.meta }, { where: { id: 1 }, transaction });
      await expect(verify(1, transaction)).rejects.toThrow('Persisted attachment storage metadata changed');
    });

    it('rejects a missing persisted record', async () => {
      const verify = captureStagedAttachmentRecord(collection, values);
      await collection.model.destroy({ where: { id: 1 }, transaction });
      await expect(verify(1, transaction)).rejects.toThrow('Persisted attachment storage metadata changed');
    });

    it('does not let a presentation getter hide a changed physical filename', async () => {
      collection.setField('filename', { type: 'string', field: 'file_name', get: () => 'server.pdf' });
      const verify = captureStagedAttachmentRecord(collection, values);
      await collection.model.update({ filename: 'changed.pdf' }, { where: { id: 1 }, transaction });
      await expect(verify(1, transaction)).rejects.toThrow('Persisted attachment storage metadata changed');
    });

    it('rejects changed physical field mapping before verification', async () => {
      const verify = captureStagedAttachmentRecord(collection, values);
      collection.model.rawAttributes.filename.field = 'another_column';
      await expect(verify(1, transaction)).rejects.toThrow('Attachment storage record identity changed');
    });

    it('rejects a changed file template instead of treating it as a normal collection', async () => {
      const verify = captureStagedAttachmentRecord(collection, values);
      collection.options.template = 'general';
      await expect(verify(1, transaction)).rejects.toThrow('Attachment storage record identity changed');
    });

    it('rejects metadata capture on a non-file collection', () => {
      collection.options.template = 'general';
      expect(() => captureStagedAttachmentRecord(collection, values)).toThrow(
        'Attachment storage record identity changed',
      );
    });

    it('rejects file schemas missing a required managed physical field', () => {
      delete collection.model.rawAttributes.url;
      expect(() => captureStagedAttachmentRecord(collection, values)).toThrow(
        'Attachment storage requires physical metadata fields',
      );
    });

    it('rejects an ended transaction rather than issuing a query outside the write', async () => {
      const verify = captureStagedAttachmentRecord(collection, values);
      await transaction.commit();
      await expect(verify(1, transaction)).rejects.toThrow('active write transaction');
    });

    it('rejects a transaction belonging to another database', async () => {
      const other = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
      const otherTransaction = await other.sequelize.transaction();
      try {
        const verify = captureStagedAttachmentRecord(collection, values);
        await expect(verify(1, otherTransaction)).rejects.toThrow('active write transaction');
      } finally {
        await otherTransaction.rollback();
        await other.close();
      }
    });
  },
);
