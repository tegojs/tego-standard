import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Collection, Database } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('independent PostgreSQL upload identity receipts', () => {
  let db: Database;
  let other: Database;
  let collection: Collection;
  let receipts: InstanceType<typeof files.StagedAttachmentReceiptJournal>;
  let reader: InstanceType<typeof files.StagedAttachmentReceiptJournal>;
  let plan: files.StagedAttachmentStoragePlan;
  let expected: { root: string; values: files.StagedAttachmentStorageValues };
  let captured: files.StagedAttachmentLocalReceipt;
  let directory: string;
  const bytes = Buffer.from('Persistent identity');
  const define = (database: Database) =>
    database.collection({
      name: 'attachment_object_receipts',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'payload', type: 'jsonb' },
      ],
    });
  const destination = () => path.join(expected.root, expected.values.path, expected.values.filename);

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl);
    other = isolatedPostgresDatabase(postgresUrl);
    collection = define(db);
    const second = define(other);
    db.collection({
      name: 'receipt_operations',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'state', type: 'string' },
      ],
    });
    await db.sync();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-persistent-receipt-'));
    const root = path.join(directory, 'root');
    await fs.mkdir(root);
    const staged = path.join(directory, 'staged');
    await fs.writeFile(staged, bytes);
    plan = await files.prepareStagedAttachmentStorage(
      {
        id: 17,
        name: 'local',
        title: 'Local',
        type: 'local',
        baseUrl: '/files',
        path: 'tenants/B',
        options: { documentRoot: root },
      },
      { path: staged, originalname: 'receipt.pdf', mimetype: 'application/pdf', size: bytes.length },
    );
    expected = { root, values: plan.values };
    receipts = new files.StagedAttachmentReceiptJournal(collection);
    reader = new files.StagedAttachmentReceiptJournal(second);
  });

  afterEach(async () => {
    try {
      await plan?.discard();
    } finally {
      await db?.sequelize.query('DROP TABLE IF EXISTS "attachment_object_receipts", "receipt_operations"');
      await other?.close();
      await db?.close();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('persists while the operation is locked and survives its rollback for another instance', async () => {
    const id = randomUUID();
    await db.getRepository('receipt_operations').create({ values: { id, state: 'pending' } });
    const transaction = await db.sequelize.transaction();
    try {
      await db.getCollection('receipt_operations').model.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      await db
        .getRepository('receipt_operations')
        .update({ filterByTk: id, values: { state: 'committed' }, transaction });
      await plan.storeForRecovery(async (receipt) => {
        captured = JSON.parse(JSON.stringify(receipt));
        await receipts.persist(id, expected, receipt);
        expect(await reader.inspect(id, expected)).toEqual({
          receipt: captured,
          object: { state: 'present', size: 0 },
        });
      });
    } finally {
      await transaction.rollback();
    }
    expect((await db.getRepository('receipt_operations').findOne({ filterByTk: id })).get('state')).toBe('pending');
    expect(await reader.inspect(id, expected)).toEqual({
      receipt: captured,
      object: { state: 'present', size: bytes.length },
    });
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('never overwrites an earlier operation receipt', async () => {
    const id = randomUUID();
    await plan.storeForRecovery(async (receipt) => {
      await receipts.persist(id, expected, receipt);
      await expect(receipts.persist(id, expected, receipt)).rejects.toThrow();
    });
    expect(await collection.repository.count()).toBe(1);
    expect((await reader.inspect(id, expected)).object).toEqual({ state: 'present', size: bytes.length });
  });

  it('does not persist a receipt after content copying has already started', async () => {
    await plan.storeForRecovery(async (receipt) => {
      captured = receipt;
    });
    await expect(receipts.persist(randomUUID(), expected, captured)).rejects.toBeInstanceOf(TypeError);
    expect(await collection.repository.count()).toBe(0);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('rejects mismatched metadata without creating a receipt or copying bytes', async () => {
    await expect(
      plan.storeForRecovery(async (receipt) => {
        await receipts.persist(randomUUID(), expected, { ...receipt, storageId: 99 });
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await collection.repository.count()).toBe(0);
    expect((await fs.stat(destination())).size).toBe(0);
  });

  it('does not infer ownership from a missing receipt', async () => {
    await expect(reader.inspect(randomUUID(), expected)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readdir(expected.root)).toEqual([]);
  });

  it('revalidates persisted identities against the actual object', async () => {
    const id = randomUUID();
    await plan.storeForRecovery(async (receipt) => {
      await receipts.persist(id, expected, receipt);
    });
    await fs.rename(destination(), path.join(directory, 'original'));
    await fs.writeFile(destination(), 'replacement');
    await expect(reader.inspect(id, expected)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination(), 'utf8')).toBe('replacement');
    // Discard must also refuse the replacement; leave only the test-owned directory cleanup.
    await expect(plan.discard()).rejects.toBeInstanceOf(TypeError);
    plan = undefined;
  });

  it('rejects model replacement before saving any receipt', async () => {
    const original = collection.model.rawAttributes.payload;
    collection.model.rawAttributes.payload = { ...original };
    try {
      await expect(
        plan.storeForRecovery(async (receipt) => {
          await receipts.persist(randomUUID(), expected, receipt);
        }),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      collection.model.rawAttributes.payload = original;
    }
    expect(await collection.repository.count()).toBe(0);
    expect((await fs.stat(destination())).size).toBe(0);
  });

  it('rejects a real unmodelled foreign key that could wait on the operation row', async () => {
    const id = randomUUID();
    await db.getRepository('receipt_operations').create({ values: { id, state: 'pending' } });
    await db.sequelize.query(
      'ALTER TABLE "attachment_object_receipts" ADD CONSTRAINT receipt_operation_fk FOREIGN KEY (id) REFERENCES "receipt_operations" (id)',
    );
    await expect(
      plan.storeForRecovery(async (receipt) => {
        await receipts.persist(id, expected, receipt);
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await collection.repository.count()).toBe(0);
    expect((await fs.stat(destination())).size).toBe(0);
  });

  it.each([
    [
      'missing primary key',
      'ALTER TABLE "attachment_object_receipts" DROP CONSTRAINT "attachment_object_receipts_pkey"',
    ],
    ['hidden operation column', 'ALTER TABLE "attachment_object_receipts" ADD COLUMN state text'],
  ])('rejects a physically incompatible receipt table: %s', async (_name, sql) => {
    await db.sequelize.query(sql);
    await expect(
      plan.storeForRecovery(async (receipt) => {
        await receipts.persist(randomUUID(), expected, receipt);
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await collection.repository.count()).toBe(0);
    expect((await fs.stat(destination())).size).toBe(0);
  });

  it('persists the captured identities when the caller changes its receipt during the await', async () => {
    const id = randomUUID();
    await plan.storeForRecovery(async (receipt) => {
      const mutable = JSON.parse(JSON.stringify(receipt));
      captured = JSON.parse(JSON.stringify(receipt));
      const saving = receipts.persist(id, expected, mutable);
      mutable.object.ino = '0';
      mutable.directories.length = 0;
      await saving;
    });
    expect((await reader.inspect(id, expected)).receipt).toEqual(captured);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });
});
