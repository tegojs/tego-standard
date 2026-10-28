import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Collection, Database, Transaction } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { waitForAssertion } from '../../../../module-workflow/src/server/__tests__/utils';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('controlled recovery of local staged objects', () => {
  let db: Database;
  let other: Database;
  let operations: Collection;
  let journal: files.StagedAttachmentJournal;
  let second: files.StagedAttachmentJournal;
  let receipts: files.StagedAttachmentReceiptJournal;
  let localReceipts: files.StagedAttachmentReceiptJournal;
  let directory: string;
  let root: string;
  let storage: files.StagedAttachmentStorage;
  let plan: files.StagedAttachmentStoragePlan;
  let operation: Awaited<ReturnType<files.StagedAttachmentJournal['prepare']>>;
  let transaction: Transaction & { finished?: string };
  const bytes = Buffer.from('Cancelled recovery bytes');
  const destination = () => path.join(root, plan.values.path, plan.values.filename);
  const define = (database: Database) => {
    const markers = database.collection({
      name: 'recovery_operations',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'state', type: 'string' },
        { name: 'payload', type: 'jsonb' },
      ],
    });
    const identities = database.collection({
      name: 'recovery_receipts',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'payload', type: 'jsonb' },
      ],
    });
    return { markers, identities };
  };

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl);
    other = isolatedPostgresDatabase(postgresUrl);
    const first = define(db);
    const remote = define(other);
    operations = first.markers;
    await db.sync();
    journal = new files.StagedAttachmentJournal(operations);
    second = new files.StagedAttachmentJournal(remote.markers);
    receipts = new files.StagedAttachmentReceiptJournal(remote.identities);
    localReceipts = new files.StagedAttachmentReceiptJournal(first.identities);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-staged-recovery-'));
    root = path.join(directory, 'root');
    await fs.mkdir(root);
    const staged = path.join(directory, 'staged');
    await fs.writeFile(staged, bytes);
    storage = {
      id: 17,
      name: 'local',
      title: 'Local',
      type: 'local',
      baseUrl: '/files',
      path: 'tenants/B',
      options: { documentRoot: root },
    };
    plan = await files.prepareStagedAttachmentStorage(storage, {
      path: staged,
      originalname: 'recover.pdf',
      mimetype: 'application/pdf',
      size: bytes.length,
    });
    operation = await journal.prepare(storage, plan.values);
    transaction = undefined;
  });

  afterEach(async () => {
    try {
      if (transaction && !transaction.finished) await transaction.rollback();
      await plan?.discard();
    } finally {
      await db?.sequelize.query('DROP TABLE IF EXISTS "recovery_receipts", "recovery_operations"');
      await other?.close();
      await db?.close();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  async function write(incomplete = false) {
    transaction = await db.sequelize.transaction();
    await operation.lock(transaction);
    try {
      await plan.storeForRecovery(async (receipt) => {
        await receipts.persist(operation.id, { root, values: plan.values }, receipt);
        if (incomplete) throw new Error('Interrupted before content copy');
      });
    } catch (error) {
      if (!incomplete) throw error;
    }
  }
  const recover = () => files.recoverStagedAttachment(journal, receipts, operation.id);

  it('cancels a rolled-back operation and removes only its verified object, with repeatable recovery', async () => {
    await write();
    await transaction.rollback();
    const unrelated = path.join(root, 'keep.txt');
    await fs.writeFile(unrelated, 'keep');
    expect(await recover()).toEqual({ state: 'removed' });
    expect((await operations.repository.findOne({ filterByTk: operation.id })).get('state')).toBe('cancelled');
    await expect(fs.stat(destination())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recover()).toEqual({ state: 'missing' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('keep');
  });

  it('keeps a committed object regardless of recovery requests', async () => {
    await write();
    await transaction.commit();
    expect(await recover()).toEqual({ state: 'retained' });
    expect(await fs.readFile(destination())).toEqual(bytes);
    expect((await operations.repository.findOne({ filterByTk: operation.id })).get('state')).toBe('committed');
  });

  it('can clean a zero-byte object after its original transaction is known rolled back', async () => {
    await write(true);
    await transaction.rollback();
    expect((await fs.stat(destination())).size).toBe(0);
    expect(await recover()).toEqual({ state: 'removed' });
    await expect(fs.stat(destination())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an already missing object as complete only with matching parent identities', async () => {
    await write();
    await transaction.rollback();
    await fs.unlink(destination());
    expect(await recover()).toEqual({ state: 'missing' });
  });

  it('does not guess ownership when there is no durable identity receipt', async () => {
    await expect(recover()).rejects.toBeInstanceOf(TypeError);
    expect((await operations.repository.findOne({ filterByTk: operation.id })).get('state')).toBe('cancelled');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('preserves a replacement and can retry after the original object is restored', async () => {
    await write();
    await transaction.rollback();
    const saved = path.join(directory, 'original');
    await fs.rename(destination(), saved);
    await fs.writeFile(destination(), 'replacement');
    await expect(recover()).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination(), 'utf8')).toBe('replacement');
    expect((await operations.repository.findOne({ filterByTk: operation.id })).get('state')).toBe('cancelled');
    await fs.unlink(destination());
    await fs.rename(saved, destination());
    expect(await recover()).toEqual({ state: 'removed' });
  });

  it('preserves objects whose original parent directory was replaced', async () => {
    await write();
    await transaction.rollback();
    const saved = path.join(directory, 'original-parent');
    await fs.rename(path.dirname(destination()), saved);
    await fs.mkdir(path.dirname(destination()));
    await fs.rename(path.join(saved, plan.values.filename), destination());
    await expect(recover()).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('rejects an altered marker location instead of deleting the real object', async () => {
    await write();
    await transaction.rollback();
    await operations.repository.update({
      filterByTk: operation.id,
      values: { payload: { root, values: { ...plan.values, filename: 'different.pdf' } } },
    });
    await expect(recover()).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('rejects a shared receipt pool before cancelling an operation', async () => {
    await expect(files.recoverStagedAttachment(journal, localReceipts, operation.id)).rejects.toBeInstanceOf(TypeError);
    expect((await operations.repository.findOne({ filterByTk: operation.id })).get('state')).toBe('pending');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('serializes two recovery requests without deleting or claiming the object twice', async () => {
    await write();
    await transaction.rollback();
    const results = await Promise.allSettled([
      recover(),
      files.recoverStagedAttachment(second, localReceipts, operation.id),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(results.map((result) => (result.status === 'fulfilled' ? result.value.state : undefined)).sort()).toEqual([
      'missing',
      'removed',
    ]);
    await expect(fs.stat(destination())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds its operation lock until the first awaited recovery executor finishes', async () => {
    let entered: () => void;
    let release: () => void;
    let secondEntered = false;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = journal.withCancelledRecovery(operation.id, async () => {
      entered();
      await barrier;
      return 'first';
    });
    void first.catch(() => {});
    let next: ReturnType<typeof second.withCancelledRecovery>;
    try {
      await Promise.race([
        ready,
        first.then(() => {
          throw new Error('Recovery ended before entering its executor');
        }),
      ]);
      next = second.withCancelledRecovery(operation.id, async () => {
        secondEntered = true;
        return 'second';
      });
      void next.catch(() => {});
      await waitForAssertion(async () => {
        const [rows] = await db.sequelize.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%recovery_operations%'",
        );
        expect(rows).toHaveLength(1);
      });
      expect(secondEntered).toBe(false);
    } finally {
      release();
      await Promise.allSettled([first, next]);
    }
    expect(await first).toEqual({ state: 'cancelled', result: 'first' });
    expect(await next).toEqual({ state: 'cancelled', result: 'second' });
  });

  it.each([false, true])('waits for the live original writer before deciding, rollback=%s', async (rollback) => {
    await write();
    const pending = recover();
    void pending.catch(() => {});
    try {
      await waitForAssertion(async () => {
        const [rows] = await other.sequelize.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%recovery_operations%'",
        );
        expect(rows).toHaveLength(1);
      });
      expect(await fs.readFile(destination())).toEqual(bytes);
    } finally {
      if (rollback) await transaction.rollback();
      else await transaction.commit();
      await pending.catch(() => {});
    }
    expect(await pending).toEqual({ state: rollback ? 'removed' : 'retained' });
    if (!rollback) expect(await fs.readFile(destination())).toEqual(bytes);
  });
});
