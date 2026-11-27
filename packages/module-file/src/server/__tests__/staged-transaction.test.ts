import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import type { Context, Transaction } from '@tego/server';

import * as files from '..';
import type { StagedAttachmentStoragePlan } from '../storages/staged-upload';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

function postgresOptions() {
  const connection = new URL(postgresUrl);
  if (
    !['postgres:', 'postgresql:'].includes(connection.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
    !/^\/tego_tenant_access_test_[a-f0-9]{10}$/.test(connection.pathname)
  )
    throw new TypeError('Attachment coordination tests require a dedicated local PostgreSQL database');
  return {
    dialect: 'postgres' as const,
    host: connection.hostname,
    port: Number(connection.port || 5432),
    database: connection.pathname.slice(1),
    username: decodeURIComponent(connection.username),
    password: decodeURIComponent(connection.password),
    logging: false as const,
    pool: { max: 3 },
  };
}

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'staged attachment transaction coordination (%s)',
  (dialect) => {
    let app: MockServer;
    let directory: string;
    let staging: string;
    let root: string;
    let values: StagedAttachmentStoragePlan['values'];
    let staged: files.StagedAttachmentUpload;
    let observed: unknown;
    let execute: (input: {
      transaction: Transaction;
      values: StagedAttachmentStoragePlan['values'];
      store: () => Promise<void>;
    }) => Promise<unknown>;
    const bytes = Buffer.from('Transaction attachment bytes');
    const filePath = () => path.join(root, 'files', values.filename);

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-staged-transaction-'));
      staging = path.join(directory, 'staging');
      root = path.join(directory, 'storage');
      await fs.mkdir(staging);
      await fs.mkdir(root);
      observed = undefined;
      app = mockServer({
        acl: false,
        registerActions: true,
        database: dialect === 'postgres' ? postgresOptions() : { dialect: 'sqlite', storage: ':memory:' },
        resourcer: { prefix: '/api' },
      });
      app.db.collection({
        name: 'testAttachments',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'filename', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      });
      await app.db.sync();
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await store();
        return { key: 1 };
      };
      app.resourcer.define({
        name: 'uploads',
        actions: {
          upload: async (ctx: Context) => {
            try {
              ctx.body = await files.withStagedAttachmentUpload(
                ctx,
                { directory: staging, maxFileSize: 1024 },
                async (file) => {
                  staged = file;
                  return files.withStagedAttachmentTransaction(
                    app.db,
                    {
                      id: 17,
                      title: 'Test storage',
                      type: 'local',
                      name: 'local',
                      baseUrl: '/files',
                      path: 'files',
                      options: { documentRoot: root },
                    },
                    file,
                    async (input) => {
                      values = input.values;
                      return execute(input);
                    },
                  );
                },
              );
            } catch (error) {
              observed = error;
              ctx.status = 400;
              ctx.body = { error: 'Test upload rejected' };
            }
          },
        },
      });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        if (dialect === 'postgres') await app?.db.getCollection('testAttachments')?.model.drop();
      } finally {
        await app?.destroy();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
    const upload = () =>
      supertest(app.callback()).post('/api/uploads:upload').attach('file', bytes, { filename: 'receipt.pdf' });
    const records = () => app.db.getRepository('testAttachments').find({});
    const insert = (transaction: Transaction, filename: string) =>
      app.db.getRepository('testAttachments').create({ values: { id: 1, tenantId: 'B', filename }, transaction });

    it('returns success only after actual bytes and the database record are committed', async () => {
      let committedBytes: Buffer | undefined;
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        transaction.afterCommit(async () => {
          committedBytes = await fs.readFile(filePath());
        });
        await store();
        return { key: 1 };
      };
      const response = await upload();
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ key: 1 });
      expect((await records()).map((record) => record.get())).toEqual([
        { id: 1, tenantId: 'B', filename: values.filename },
      ]);
      expect(committedBytes).toEqual(bytes);
      expect(await fs.readFile(filePath())).toEqual(bytes);
      expect(await fs.readdir(staging)).toEqual([]);
    });
    it('rolls back an inserted record when the trusted persistence check rejects before storage', async () => {
      const failure = new Error('Test final access check rejected');
      execute = async ({ transaction, values }) => {
        await insert(transaction, values.filename);
        throw failure;
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toBe(failure);
      expect(await records()).toEqual([]);
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('rolls back the record and removes its actual stored file after a later rejection', async () => {
      const failure = new Error('Test final G check rejected');
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await store();
        expect(await fs.readFile(filePath())).toEqual(bytes);
        throw failure;
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toBe(failure);
      expect(await records()).toEqual([]);
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each([false, true])('cannot commit a record after a real storage failure, swallowed=%s', async (swallowed) => {
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await fs.unlink(staged.path);
        if (swallowed) await store().catch(() => {});
        else await store();
        return { key: 1 };
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ code: 'ENOENT' });
      expect(await records()).toEqual([]);
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('rejects missing storage and revokes a saved store callback after execution', async () => {
      let late: () => Promise<void>;
      execute = async ({ transaction, values, store }) => {
        late = store;
        await insert(transaction, values.filename);
        return { key: 1 };
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toBeInstanceOf(TypeError);
      expect(await records()).toEqual([]);
      await expect(late()).rejects.toBeInstanceOf(TypeError);
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('waits for an already started copy even when the callback did not await it', async () => {
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        void store();
        return { key: 1 };
      };
      expect((await upload()).status).toBe(200);
      expect(await records()).toHaveLength(1);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('does not lose an unawaited storage failure or commit its record', async () => {
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await fs.unlink(staged.path);
        void store();
        return { key: 1 };
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ code: 'ENOENT' });
      expect(await records()).toEqual([]);
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each([false, true])(
      'defers partial-file cleanup until rollback is confirmed, lost acknowledgement=%s',
      async (lost) => {
        const failure = new Error('Test actual staged stream failed');
        const rollbackFailure = new Error('Test actual rollback acknowledgement lost');
        const open = fs.open.bind(fs);
        const query = app.db.sequelize.query.bind(app.db.sequelize);
        let fileExistedBeforeRollback = false;
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (args[0] === staged.path) {
            const createReadStream = handle.createReadStream.bind(handle);
            vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
              const stream = createReadStream(options);
              stream.once('data', () => stream.destroy(failure));
              return stream;
            });
          }
          return handle;
        });
        vi.spyOn(app.db.sequelize, 'query').mockImplementation(async (...args) => {
          const rollback = typeof args[0] === 'string' && /^ROLLBACK\b/i.test(args[0]);
          if (rollback) fileExistedBeforeRollback = (await fs.stat(filePath())).isFile();
          const result = await query(...args);
          if (rollback && lost) throw rollbackFailure;
          return result;
        });
        expect((await upload()).status).toBe(400);
        expect(fileExistedBeforeRollback).toBe(true);
        expect(await records()).toEqual([]);
        if (lost) {
          expect(observed).toMatchObject({
            phase: 'rollback',
            recoveryRequired: true,
            errors: [failure, rollbackFailure],
          });
          expect((await fs.stat(filePath())).isFile()).toBe(true);
        } else {
          expect(observed).toBe(failure);
          await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
        }
      },
    );
    it('settles an unawaited copy before rollback and cleans it after an execution error', async () => {
      const failure = new Error('Test callback rejected during copy');
      let bytesAtRollback: Buffer | undefined;
      const query = app.db.sequelize.query.bind(app.db.sequelize);
      vi.spyOn(app.db.sequelize, 'query').mockImplementation(async (...args) => {
        if (typeof args[0] === 'string' && /^ROLLBACK\b/i.test(args[0]))
          bytesAtRollback = await fs.readFile(filePath());
        return query(...args);
      });
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        void store();
        throw failure;
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toBe(failure);
      expect(bytesAtRollback).toEqual(bytes);
      expect(await records()).toEqual([]);
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('revokes the store callback after a successful commit without changing committed bytes', async () => {
      let late: () => Promise<void>;
      execute = async ({ transaction, values, store }) => {
        late = store;
        await insert(transaction, values.filename);
        await store();
        return { key: 1 };
      };
      expect((await upload()).status).toBe(200);
      await expect(late()).rejects.toBeInstanceOf(TypeError);
      expect(await records()).toHaveLength(1);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('does not delete a committed attachment when a real afterCommit hook throws', async () => {
      const failure = new Error('Test post-commit notification failed');
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await store();
        transaction.afterCommit(() => {
          throw failure;
        });
        return { key: 1 };
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ phase: 'commit', recoveryRequired: true, errors: [failure] });
      expect(await records()).toHaveLength(1);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('preserves bytes when the commit acknowledgement is lost after actual COMMIT', async () => {
      const failure = new Error('Test commit acknowledgement lost');
      const query = app.db.sequelize.query.bind(app.db.sequelize);
      vi.spyOn(app.db.sequelize, 'query').mockImplementation(async (...args) => {
        const result = await query(...args);
        if (typeof args[0] === 'string' && /^COMMIT\b/i.test(args[0])) throw failure;
        return result;
      });
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ phase: 'commit', recoveryRequired: true, errors: [failure] });
      expect(await records()).toHaveLength(1);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('preserves bytes and both errors when rollback acknowledgement is lost', async () => {
      const failure = new Error('Test persistence rejected');
      const rollbackFailure = new Error('Test rollback acknowledgement lost');
      const query = app.db.sequelize.query.bind(app.db.sequelize);
      vi.spyOn(app.db.sequelize, 'query').mockImplementation(async (...args) => {
        const result = await query(...args);
        if (typeof args[0] === 'string' && /^ROLLBACK\b/i.test(args[0])) throw rollbackFailure;
        return result;
      });
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await store();
        throw failure;
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({
        phase: 'rollback',
        recoveryRequired: true,
        errors: [failure, rollbackFailure],
      });
      expect(await records()).toEqual([]);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('reports cleanup failure without losing the original rejection or claiming success', async () => {
      const failure = new Error('Test persistence rejected');
      const cleanupFailure = new Error('Test storage temporarily unavailable');
      const unlink = fs.unlink.bind(fs);
      vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (target === filePath()) throw cleanupFailure;
        return unlink(target);
      });
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await store();
        throw failure;
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ phase: 'discard', recoveryRequired: true, errors: [failure, cleanupFailure] });
      expect(await records()).toEqual([]);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('rejects a callback that committed its transaction and never deletes its committed bytes', async () => {
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        await store();
        await transaction.commit();
        return { key: 1 };
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ phase: 'transaction', recoveryRequired: true });
      expect(await records()).toHaveLength(1);
      expect(await fs.readFile(filePath())).toEqual(bytes);
    });
    it('preserves a created object when the callback commits before its unawaited copy fails', async () => {
      const failure = new Error('Test stream failed after callback commit');
      const open = fs.open.bind(fs);
      let committed: Promise<void>;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === staged.path) {
          const createReadStream = handle.createReadStream.bind(handle);
          vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
            const stream = createReadStream(options);
            stream.once('data', () => {
              stream.pause();
              void committed.then(() => stream.destroy(failure));
            });
            return stream;
          });
        }
        return handle;
      });
      execute = async ({ transaction, values, store }) => {
        await insert(transaction, values.filename);
        void store();
        committed = transaction.commit();
        await committed;
        return { key: 1 };
      };
      expect((await upload()).status).toBe(400);
      expect(observed).toMatchObject({ phase: 'transaction', recoveryRequired: true, errors: [failure] });
      expect(await records()).toHaveLength(1);
      expect((await fs.stat(filePath())).isFile()).toBe(true);
    });
  },
);
