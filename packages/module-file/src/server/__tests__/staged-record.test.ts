import { mockDatabase, Transaction, type Collection, type Database } from '@tego/server';

import { captureStagedAttachmentRecord, type StagedAttachmentStorageValues } from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

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
      collection = db.collection({
        name: 'files',
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
