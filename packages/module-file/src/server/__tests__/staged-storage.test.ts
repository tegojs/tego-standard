import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import type { Context } from '@tego/server';

import * as files from '..';
import type { StagedAttachmentStoragePlan } from '../storages/staged-upload';

describe('local staged attachment storage plans', () => {
  let app: MockServer;
  let directory: string;
  let staging: string;
  let root: string;
  let storage: {
    id: number;
    title: string;
    type: string;
    name: string;
    baseUrl: string;
    path: string;
    options: { documentRoot: string };
  };
  let plan: StagedAttachmentStoragePlan;
  let consume: (file: files.StagedAttachmentUpload) => Promise<unknown>;
  let observed: unknown;
  const bytes = Buffer.from('New attachment bytes');
  const filePath = () => path.join(root, 'tenants', 'B', plan.values.filename);

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-staged-storage-'));
    staging = path.join(directory, 'staging');
    root = path.join(directory, 'storage');
    await fs.mkdir(staging);
    await fs.mkdir(root);
    storage = {
      id: 17,
      title: 'Test storage',
      type: 'local',
      name: 'local',
      baseUrl: '/files',
      path: 'tenants/B',
      options: { documentRoot: root },
    };
    observed = undefined;
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      return plan.values;
    };
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    app.resourcer.define({
      name: 'uploads',
      actions: {
        upload: async (ctx: Context) => {
          try {
            ctx.body = await files.withStagedAttachmentUpload(ctx, { directory: staging, maxFileSize: 1024 }, consume);
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
    await app?.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const upload = (name = '付款凭证.pdf') =>
    supertest(app.callback()).post('/api/uploads:upload').attach('file', bytes, { filename: name });

  it('plans immutable storage metadata without writing a final file', async () => {
    const response = await upload();
    expect(response.status).toBe(200);
    expect(plan.values).toEqual({
      title: '付款凭证',
      filename: expect.stringMatching(/^[a-f0-9]{32}\.pdf$/),
      extname: '.pdf',
      size: bytes.length,
      mimetype: 'application/pdf',
      path: 'tenants/B',
      url: `/files/tenants/B/${plan.values.filename}`,
      storageId: 17,
      meta: {},
    });
    expect(Object.isFrozen(plan.values)).toBe(true);
    expect(Object.isFrozen(plan.values.meta)).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(staging)).toEqual([]);
  });
  it('stores actual bytes and keeps them after the temporary upload is cleaned', async () => {
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await plan.store();
      return plan.values;
    };
    expect((await upload()).status).toBe(200);
    expect(await fs.readFile(filePath())).toEqual(bytes);
    expect(await fs.readdir(staging)).toEqual([]);
    await plan.discard();
    await plan.discard();
    await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not read changed storage options after planning', async () => {
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      storage.path = 'outside';
      storage.options.documentRoot = path.join(directory, 'other');
      storage.baseUrl = '/changed';
      await plan.store();
      return plan.values;
    };
    expect((await upload()).status).toBe(200);
    expect(plan.values.path).toBe('tenants/B');
    expect(plan.values.url).toBe(`/files/tenants/B/${plan.values.filename}`);
    expect(await fs.readFile(filePath())).toEqual(bytes);
    await expect(fs.stat(path.join(directory, 'other'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not overwrite or delete a pre-existing conflicting object', async () => {
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await fs.mkdir(path.dirname(filePath()), { recursive: true });
      await fs.writeFile(filePath(), 'Existing object');
      await expect(plan.store()).rejects.toMatchObject({ code: 'EEXIST' });
      await plan.discard();
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(await fs.readFile(filePath(), 'utf8')).toBe('Existing object');
  });
  it('rejects a second store and preserves the original stored bytes', async () => {
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await plan.store();
      await expect(plan.store()).rejects.toThrow();
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(await fs.readFile(filePath())).toEqual(bytes);
  });
  it('cannot store after discard or use a temporary file after its callback ends', async () => {
    expect((await upload()).status).toBe(200);
    await expect(plan.store()).rejects.toThrow();
    await plan.discard();
    await expect(plan.store()).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('cannot store a discarded plan even while its staged upload remains available', async () => {
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await plan.discard();
      await expect(plan.store()).rejects.toThrow();
      expect(await fs.readFile(file.path)).toEqual(bytes);
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('keeps a different existing file when a stored object is replaced before discard', async () => {
    let cleanupError: unknown;
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await plan.store();
      await fs.rename(filePath(), `${filePath()}.original`);
      await fs.writeFile(filePath(), 'Different file');
      try {
        await plan.discard();
      } catch (error) {
        cleanupError = error;
      }
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(cleanupError).toMatchObject({ message: expect.stringMatching(/replaced/) });
    expect(await fs.readFile(filePath(), 'utf8')).toBe('Different file');
    expect(await fs.readFile(`${filePath()}.original`)).toEqual(bytes);
  });
  it('does not accept a same-sized replacement as the object just stored', async () => {
    const stat = fs.stat.bind(fs);
    const lstat = fs.lstat.bind(fs);
    let replaced = false;
    let failure: unknown;
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      const replace = async (target: unknown) => {
        if (target !== filePath() || replaced || !existsSync(filePath())) return;
        replaced = true;
        await fs.rename(filePath(), `${filePath()}.original`);
        await fs.writeFile(filePath(), Buffer.alloc(bytes.length, 88));
      };
      vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        await replace(args[0]);
        return stat(...args);
      });
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        await replace(args[0]);
        return lstat(...args);
      });
      try {
        await plan.store();
      } catch (error) {
        failure = error;
      }
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(replaced).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(await fs.readFile(filePath())).toEqual(Buffer.alloc(bytes.length, 88));
    expect(await fs.readFile(`${filePath()}.original`)).toEqual(bytes);
  });
  it('keeps cleanup pending if object identity cannot be established after exclusive creation', async () => {
    const open = fs.open.bind(fs);
    const failure = new Error('Test output identity read failed');
    let storingError: unknown;
    let cleanupError: unknown;
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === filePath() && args[1] === 'wx') vi.spyOn(handle, 'stat').mockRejectedValue(failure);
        return handle;
      });
      try {
        await plan.store();
      } catch (error) {
        storingError = error;
      }
      try {
        await plan.discard();
      } catch (error) {
        cleanupError = error;
      }
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(storingError).toBeInstanceOf(AggregateError);
    expect(cleanupError).toMatchObject({ message: expect.stringMatching(/identity/) });
    expect((await fs.stat(filePath())).isFile()).toBe(true);
  });
  it('closes the streams and removes only its newly created object after an actual read failure', async () => {
    const failure = new Error('Test staged read interrupted');
    const open = fs.open.bind(fs);
    let created = false;
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await fs.mkdir(path.dirname(filePath()), { recursive: true });
      const other = path.join(path.dirname(filePath()), 'keep.txt');
      await fs.writeFile(other, 'Keep this file');
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === file.path) {
          const createReadStream = handle.createReadStream.bind(handle);
          vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
            const stream = createReadStream(options);
            stream.once('data', () => {
              created = existsSync(filePath());
              stream.destroy(failure);
            });
            return stream;
          });
        }
        return handle;
      });
      await expect(plan.store()).rejects.toBe(failure);
      await plan.discard();
      await expect(fs.stat(filePath())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(other, 'utf8')).toBe('Keep this file');
      return {};
    };
    expect((await upload()).status).toBe(200);
    expect(created).toBe(true);
    expect(await fs.readdir(staging)).toEqual([]);
  });
  it('isolates concurrent plans and discards only the selected new file', async () => {
    const plans: StagedAttachmentStoragePlan[] = [];
    consume = async (file) => {
      const selected = await files.prepareStagedAttachmentStorage(storage, file);
      plans.push(selected);
      await selected.store();
      return selected.values;
    };
    const responses = await Promise.all([upload(), upload()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(plans).toHaveLength(2);
    expect(plans[0].values.filename).not.toBe(plans[1].values.filename);
    await plans[0].discard();
    await expect(fs.stat(path.join(root, 'tenants', 'B', plans[0].values.filename))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(root, 'tenants', 'B', plans[1].values.filename))).toEqual(bytes);
  });
  it.each(['../outside', '/outside', 'C:/outside', 'tenants/../outside', 'tenants\\B'])(
    'rejects a non-canonical storage path %s before writing',
    async (value) => {
      storage.path = value;
      expect((await upload()).status).toBe(400);
      expect(observed).toBeInstanceOf(Error);
      expect(await fs.readdir(root)).toEqual([]);
      expect(await fs.readdir(staging)).toEqual([]);
    },
  );
  it('does not follow a directory junction out of the configured storage root', async () => {
    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'tenants'), 'junction');
    consume = async (file) => {
      plan = await files.prepareStagedAttachmentStorage(storage, file);
      await plan.store();
      return {};
    };
    expect((await upload()).status).toBe(400);
    expect(observed).toBeInstanceOf(Error);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('refuses an unsupported storage instead of calling its legacy upload engine', async () => {
    storage.type = 's3';
    expect((await upload()).status).toBe(400);
    expect(observed).toBeInstanceOf(Error);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
