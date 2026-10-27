import streamFs, { promises as fs, type WriteStream } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import type { Context } from '@tego/server';

import * as files from '..';
import ErrorPlugin from '../../../../module-error-handler/src/server';

describe('isolated attachment upload staging', () => {
  let app: MockServer;
  let directory: string;
  let staging: string;
  let destination: string;
  let options: files.StagedAttachmentOptions;
  let consume: (file: files.StagedAttachmentUpload) => Promise<unknown>;
  let seen: files.StagedAttachmentUpload | undefined;
  let observed: unknown;
  let alreadyParsed: boolean;
  let outputs: WriteStream[];
  let settled: Promise<void>;
  let settle: () => void;
  const bytes = Buffer.from('Temporary upload bytes');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-upload-staging-'));
    staging = path.join(directory, 'staging');
    destination = path.join(directory, 'final');
    await fs.mkdir(staging);
    await fs.mkdir(destination);
    options = { directory: staging, maxFileSize: 1024 };
    seen = undefined;
    observed = undefined;
    alreadyParsed = false;
    outputs = [];
    settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    consume = async (file) => {
      expect(await fs.readFile(file.path)).toEqual(bytes);
      return { size: file.size, name: file.originalname, type: file.mimetype };
    };
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    const errors = new ErrorPlugin(app, { name: 'test-errors' });
    await errors.beforeLoad();
    await errors.load();
    app.resourcer.define({
      name: 'uploads',
      actions: {
        upload: async (ctx: Context) => {
          if (alreadyParsed) ctx.file = { path: 'Previously parsed file' };
          try {
            ctx.body = await files.withStagedAttachmentUpload(ctx, options, async (file) => {
              seen = file;
              return consume(file);
            });
          } catch (error) {
            observed = error;
            throw error;
          } finally {
            settle();
          }
        },
      },
    });
  });
  afterEach(async () => {
    for (const output of outputs) {
      if (!output.closed)
        await new Promise<void>((resolve) => {
          output.once('close', resolve);
          output.destroy();
        });
    }
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await app?.destroy();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  const upload = (filename = 'proof.txt') =>
    supertest(app.callback()).post('/api/uploads:upload').attach('file', bytes, { filename });
  const leftovers = () => fs.readdir(staging);

  it('exposes original bytes only during the callback and removes the private directory on success', async () => {
    const response = await upload();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ size: bytes.length, name: 'proof.txt', type: 'text/plain' });
    expect(seen).toBeDefined();
    await expect(fs.stat(seen!.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await leftovers()).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([]);
  });
  it('does not derive a staging path from a client filename', async () => {
    const response = await upload('../../outside.txt');
    expect(response.status).toBe(200);
    const relative = path.relative(staging, seen!.path);
    expect(relative.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(path.basename(seen!.path)).not.toBe('outside.txt');
    expect((await fs.readdir(directory)).sort()).toEqual(['final', 'staging']);
    expect(await leftovers()).toEqual([]);
  });
  it('keeps an explicitly saved final copy and removes only its own temporary directory', async () => {
    consume = async (file) => {
      await fs.copyFile(file.path, path.join(destination, 'saved.txt'));
      return { saved: true };
    };
    expect((await upload()).status).toBe(200);
    expect(await fs.readFile(path.join(destination, 'saved.txt'))).toEqual(bytes);
    expect(await leftovers()).toEqual([]);
  });
  it('removes temporary files and propagates the original callback failure', async () => {
    const failure = new Error('Tenant write was rejected');
    consume = async (file) => {
      expect(await fs.readFile(file.path)).toEqual(bytes);
      throw failure;
    };
    const response = await upload();
    expect(response.status).toBe(500);
    expect(observed).toBe(failure);
    expect(await leftovers()).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([]);
  });
  it('enforces the explicit server file size limit and cleans parser failures', async () => {
    options.maxFileSize = bytes.length - 1;
    const response = await upload();
    expect(response.status).toBe(400);
    expect(seen).toBeUndefined();
    expect(await leftovers()).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([]);
  });
  it('closes real output handles before cleanup when the multipart file is truncated', async () => {
    const create = streamFs.createWriteStream.bind(streamFs);
    vi.spyOn(streamFs, 'createWriteStream').mockImplementation((...args) => {
      const output = create(...args);
      outputs.push(output);
      return output;
    });
    syncBuiltinESMExports();
    const boundary = 'tego-truncated-file-boundary';
    const response = await supertest(app.callback())
      .post('/api/uploads:upload')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(
        Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="broken.txt"\r\nContent-Type: text/plain\r\n\r\n`,
          ),
          bytes,
        ]),
      )
      .timeout({ deadline: 3000 });
    expect(response.status).toBe(500);
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((output) => output.closed)).toBe(true);
    expect(seen).toBeUndefined();
    expect(await leftovers()).toEqual([]);
  });
  it('closes and cleans an in-progress upload after the client disconnects', async () => {
    const create = streamFs.createWriteStream.bind(streamFs);
    let opened!: () => void;
    const outputOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    vi.spyOn(streamFs, 'createWriteStream').mockImplementation((...args) => {
      const output = create(...args);
      outputs.push(output);
      output.once('open', opened);
      return output;
    });
    syncBuiltinESMExports();
    const server = createServer(app.callback());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const boundary = 'tego-aborted-file-boundary';
    const client = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/uploads:upload',
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    client.on('error', () => {});
    let timer: ReturnType<typeof setTimeout>;
    let openTimer: ReturnType<typeof setTimeout>;
    try {
      client.write(
        Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="aborted.txt"\r\nContent-Type: text/plain\r\n\r\n`,
          ),
          bytes,
        ]),
      );
      await Promise.race([
        outputOpened,
        new Promise<void>((_resolve, reject) => {
          openTimer = setTimeout(() => reject(new Error('Upload writer did not open')), 2000);
        }),
      ]);
      clearTimeout(openTimer!);
      client.destroy();
      const completed = await Promise.race([
        settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      expect(completed).toBe(true);
      expect(observed).toBeInstanceOf(Error);
      expect(seen).toBeUndefined();
      expect(outputs.every((output) => output.closed)).toBe(true);
      expect(await leftovers()).toEqual([]);
    } finally {
      clearTimeout(timer!);
      clearTimeout(openTimer!);
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each(['two files', 'unexpected field', 'missing file'])(
    'rejects %s without calling the consumer',
    async (kind) => {
      const request = supertest(app.callback()).post('/api/uploads:upload');
      if (kind === 'missing file') request.field('description', 'No upload');
      else if (kind === 'unexpected field') request.attach('other', bytes, { filename: 'wrong.txt' });
      else request.attach('file', bytes, { filename: 'first.txt' }).attach('file', bytes, { filename: 'second.txt' });
      expect((await request).status).toBe(400);
      expect(seen).toBeUndefined();
      expect(await leftovers()).toEqual([]);
    },
  );
  it.each([
    { mimetype: 'image/*' },
    { unregisteredRule: true },
    { toString: 'invalid rule' },
    { constructor: 'invalid rule' },
  ])('applies existing storage rules %j', async (rules) => {
    options.rules = rules;
    expect((await upload()).status).toBe(400);
    expect(seen).toBeUndefined();
    expect(await leftovers()).toEqual([]);
  });
  it('preserves the accepted storage mimetype rule', async () => {
    options.rules = { mimetype: 'text/*' };
    expect((await upload()).status).toBe(200);
    expect(seen?.mimetype).toBe('text/plain');
    expect(await leftovers()).toEqual([]);
  });
  it.each([null, { mimetype: null }])(
    'fails malformed rules %j without leaving the multipart request pending',
    async (rules) => {
      options.rules = rules as Record<string, unknown>;
      const response = await upload().timeout({ deadline: 1500 });
      expect(response.status).toBe(500);
      expect(seen).toBeUndefined();
      expect(await leftovers()).toEqual([]);
    },
  );
  it('preserves the original Unicode filename as metadata without using it for a path', async () => {
    const response = await upload('付款凭证.txt');
    expect(response.status).toBe(200);
    expect(seen?.originalname).toBe('付款凭证.txt');
    expect(path.basename(seen!.path)).not.toBe('付款凭证.txt');
    expect(await leftovers()).toEqual([]);
  });
  it.each([0, -1, NaN, Infinity, 1024 ** 3 + 1])(
    'rejects invalid server size %s before staging any bytes',
    async (size) => {
      options.maxFileSize = size;
      expect((await upload()).status).toBe(500);
      expect(observed).toBeInstanceOf(TypeError);
      expect(seen).toBeUndefined();
      expect(await leftovers()).toEqual([]);
    },
  );
  it('requires an explicit absolute staging directory', async () => {
    options.directory = 'relative-upload-staging';
    expect((await upload()).status).toBe(500);
    expect(observed).toBeInstanceOf(TypeError);
    expect(await leftovers()).toEqual([]);
  });
  it('rejects a previously parsed upload without replacing its file', async () => {
    alreadyParsed = true;
    expect((await upload()).status).toBe(400);
    expect(seen).toBeUndefined();
    expect(await leftovers()).toEqual([]);
  });
  it('keeps the chosen cleanup directory when the caller mutates its options', async () => {
    await fs.writeFile(path.join(destination, 'keep.txt'), 'Unrelated retained file');
    consume = async () => {
      options.directory = destination;
      return { accepted: true };
    };
    expect((await upload()).status).toBe(200);
    expect(await leftovers()).toEqual([]);
    expect(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('Unrelated retained file');
  });
  it('isolates simultaneous uploads in distinct private directories', async () => {
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    consume = async (file) => {
      paths.push(file.path);
      if (paths.length === 2) release();
      await bothReady;
      expect(await fs.readFile(file.path)).toEqual(bytes);
      return { accepted: true };
    };
    const responses = await Promise.all([upload('first.txt'), upload('second.txt')]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(new Set(paths.map((file) => path.dirname(file))).size).toBe(2);
    expect(await leftovers()).toEqual([]);
  });
});
