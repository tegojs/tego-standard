import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Collection, type Database, type Transaction } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Explicit test registration only; no production journal table or worker is registered.
describe.skipIf(!postgresUrl)('durable staged upload markers on PostgreSQL', () => {
  let db: Database;
  let other: Database;
  let journal: InstanceType<typeof files.StagedAttachmentJournal>;
  let recovery: InstanceType<typeof files.StagedAttachmentJournal>;
  let operations: Collection;
  let directory: string;
  let root: string;
  let storage: files.StagedAttachmentStorage;
  let file: files.StagedAttachmentUpload;
  const bytes = Buffer.from('Journal-backed attachment');
  const defineJournal = (database: Database) =>
    database.collection({
      name: 'attachment_operations',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'state', type: 'string' },
        { name: 'payload', type: 'jsonb' },
      ],
    });

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl);
    other = isolatedPostgresDatabase(postgresUrl);
    operations = defineJournal(db);
    const second = defineJournal(other);
    db.collection({
      name: 'journal_files',
      timestamps: false,
      fields: [{ name: 'filename', type: 'string' }],
    });
    await db.sync();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-upload-journal-'));
    root = path.join(directory, 'root');
    await fs.mkdir(root);
    file = {
      path: path.join(directory, 'staged'),
      originalname: 'receipt.pdf',
      mimetype: 'application/pdf',
      size: bytes.length,
    };
    await fs.writeFile(file.path, bytes);
    storage = {
      id: 17,
      title: 'Local',
      type: 'local',
      name: 'local',
      baseUrl: '/files',
      path: 'tenants/B',
      options: { documentRoot: root, secret: 'must-not-persist' },
    };
    journal = new files.StagedAttachmentJournal(operations);
    recovery = new files.StagedAttachmentJournal(second);
  });
  afterEach(async () => {
    try {
      await db?.sequelize.query('DROP TABLE IF EXISTS "journal_files", "attachment_operations"');
    } finally {
      await other?.close();
      await db?.close();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  async function persist(change?: (transaction: Transaction) => Promise<void>) {
    return files.withStagedAttachmentTransaction(
      db,
      storage,
      file,
      async ({ transaction, values, store }) => {
        await db.getRepository('journal_files').create({ values: { filename: values.filename }, transaction });
        await store();
        await change?.(transaction);
        return values.filename;
      },
      journal,
    );
  }
  async function operation() {
    return (await operations.model.unscoped().findOne({ useMaster: true })).get({ plain: true });
  }

  it('commits its marker with the actual file record and retains bytes when recovered by another instance', async () => {
    const filename = await persist();
    const marker = await operation();
    expect(marker.state).toBe('committed');
    expect(marker.payload).toMatchObject({ root, values: { filename, storageId: 17, path: 'tenants/B' } });
    expect(JSON.stringify(marker)).not.toContain('must-not-persist');
    expect((await recovery.claimRecovery(marker.id)).state).toBe('committed');
    expect(await db.getRepository('journal_files').count()).toBe(1);
    expect(await fs.readFile(path.join(root, 'tenants', 'B', filename))).toEqual(bytes);
  });

  it('does not record a rolled-back business row as committed', async () => {
    await expect(
      persist(async () => {
        throw new Error('Final access denied');
      }),
    ).rejects.toThrow('Final access denied');
    const marker = await operation();
    expect(marker.state).toBe('pending');
    expect((await recovery.claimRecovery(marker.id)).state).toBe('cancelled');
    expect((await recovery.claimRecovery(marker.id)).state).toBe('cancelled');
    expect(await db.getRepository('journal_files').count()).toBe(0);
    await expect(
      fs.stat(path.join(root, marker.payload.values.path, marker.payload.values.filename)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('journals the same captured storage root used by the actual file plan', async () => {
    const upload = persist();
    storage.options.documentRoot = path.join(directory, 'changed-after-start');
    const filename = await upload;
    expect((await operation()).payload.root).toBe(root);
    expect(await fs.readFile(path.join(root, 'tenants', 'B', filename))).toEqual(bytes);
  });

  it('keeps a committed outcome after actual COMMIT when a notification throws', async () => {
    let error: unknown;
    try {
      await persist(async (transaction) => {
        transaction.afterCommit(() => {
          throw new Error('Notification failed');
        });
      });
    } catch (failure) {
      error = failure;
    }
    const marker = await operation();
    expect(error).toMatchObject({ phase: 'commit', operationId: marker.id, recoveryRequired: true });
    expect((await recovery.claimRecovery(marker.id)).state).toBe('committed');
    expect(await db.getRepository('journal_files').count()).toBe(1);
    expect(await fs.readFile(path.join(root, marker.payload.values.path, marker.payload.values.filename))).toEqual(
      bytes,
    );
  });

  it('preserves a committed outcome even when an invalid executor commits before returning', async () => {
    await expect(
      persist(async (transaction) => {
        await transaction.commit();
      }),
    ).rejects.toMatchObject({
      phase: 'transaction',
      recoveryRequired: true,
    });
    const marker = await operation();
    expect((await recovery.claimRecovery(marker.id)).state).toBe('committed');
    expect(await db.getRepository('journal_files').count()).toBe(1);
    expect(await fs.readFile(path.join(root, marker.payload.values.path, marker.payload.values.filename))).toEqual(
      bytes,
    );
  });

  it('cancels a pending operation before its writer starts and prevents a late write transaction', async () => {
    const plan = await files.prepareStagedAttachmentStorage(storage, file);
    const entry = await journal.prepare(storage, plan.values);
    expect((await recovery.claimRecovery(entry.id)).state).toBe('cancelled');
    const transaction = await db.sequelize.transaction();
    try {
      await expect(entry.lock(transaction)).rejects.toThrow();
    } finally {
      await transaction.rollback();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each([false, true])('recovery waits for the original writer, rollback=%s', async (rollback) => {
    let release: () => void;
    let reached: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const upload = persist(async () => {
      reached();
      await resume;
      if (rollback) throw new Error('Final check rejected');
    });
    void upload.catch(() => {});
    await Promise.race([
      writing,
      upload.then(() => {
        throw new Error('Upload ended before reaching the concurrency barrier');
      }),
    ]);
    const marker = await operation();
    let settled = false;
    const claimed = recovery.claimRecovery(marker.id).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(
        async () => {
          const [rows] = await db.sequelize.query(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%attachment_operations%'",
          );
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      expect(settled).toBe(false);
    } finally {
      release();
      await Promise.allSettled([upload, claimed]);
    }
    if (rollback) await expect(upload).rejects.toThrow('Final check rejected');
    else await upload;
    expect((await claimed).state).toBe(rollback ? 'cancelled' : 'committed');
    expect(await db.getRepository('journal_files').count()).toBe(rollback ? 0 : 1);
    if (!rollback)
      expect(await fs.readFile(path.join(root, marker.payload.values.path, marker.payload.values.filename))).toEqual(
        bytes,
      );
  });

  it('does not treat a missing marker as permission to clean up', async () => {
    await expect(recovery.claimRecovery('d6cd0e46-bb61-4eec-a944-fd80ded7dafc')).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects a journal from another database before inserting a marker or writing bytes', async () => {
    await expect(
      files.withStagedAttachmentTransaction(
        db,
        storage,
        file,
        async ({ store }) => {
          await store();
        },
        recovery,
      ),
    ).rejects.toThrow('owned transaction database');
    expect(await operations.repository.count()).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects a changed marker payload rather than treating it as this upload', async () => {
    const plan = await files.prepareStagedAttachmentStorage(storage, file);
    const entry = await journal.prepare(storage, plan.values);
    await operations.repository.update({ filterByTk: entry.id, values: { payload: { root: '/other', values: {} } } });
    const transaction = await db.sequelize.transaction();
    try {
      await expect(entry.lock(transaction)).rejects.toThrow('cancelled or changed');
    } finally {
      await transaction.rollback();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rolls back file and business writes if the marker is changed inside the executor', async () => {
    await expect(
      persist(async (transaction) => {
        const row = await operations.repository.findOne({ transaction });
        await operations.repository.update({
          filterByTk: row.get('id'),
          values: { payload: { root: '/other', values: {} } },
          transaction,
        });
      }),
    ).rejects.toThrow('cancelled or changed');
    const marker = await operation();
    expect(marker.state).toBe('pending');
    expect(marker.payload.root).toBe(root);
    expect(await db.getRepository('journal_files').count()).toBe(0);
    await expect(
      fs.stat(path.join(root, marker.payload.values.path, marker.payload.values.filename)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
