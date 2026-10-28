import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as files from '..';

describe('explicit local attachment read handles', () => {
  let directory: string;
  let root: string;
  let storage: files.StagedAttachmentStorage;
  let record: { path: string; filename: string; storageId: string | number; size: number };
  const bytes = Buffer.from('Private attachment bytes');
  const location = () => path.join(root, 'tenants/B', 'receipt.txt');
  const read = <T>(consume: (handle: FileHandle) => Promise<T>) =>
    files.withLocalAttachmentRead(storage, record, consume);
  const refused = async () => {
    let consumed = false;
    await expect(
      read(async () => {
        consumed = true;
      }),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
    expect(await fs.readFile(location())).toEqual(bytes);
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-local-read-'));
    root = path.join(directory, 'root');
    await fs.mkdir(path.join(root, 'tenants/B'), { recursive: true });
    await fs.writeFile(location(), bytes);
    record = { path: 'tenants/B', filename: 'receipt.txt', storageId: 18, size: bytes.length };
    storage = {
      id: 18,
      type: 'local',
      name: 'private',
      title: 'Private',
      path: 'unused-current-upload-path',
      baseUrl: 'https://never-fetch.invalid',
      options: { documentRoot: root },
    };
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reads stored record bytes through a read-only handle and closes it on success', async () => {
    let opened: FileHandle;
    record.storageId = '18';
    expect(
      await read(async (handle) => {
        opened = handle;
        await expect(handle.write(Buffer.from('unauthorized write'))).rejects.toThrow();
        return handle.readFile();
      }),
    ).toEqual(bytes);
    await expect(opened!.stat()).rejects.toThrow();
    expect(await fs.readFile(location())).toEqual(bytes);
  });

  it('closes the actual handle and preserves a consumer error', async () => {
    let opened: FileHandle;
    const failure = new Error('consumer disconnected');
    await expect(
      read(async (handle) => {
        opened = handle;
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(opened!.stat()).rejects.toThrow();
  });

  it('supports awaited streaming without buffering the whole attachment in the reader', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 37);
    await fs.writeFile(location(), payload);
    record.size = payload.length;
    let count = 0;
    let largest = 0;
    let opened: FileHandle;
    await read(async (handle) => {
      opened = handle;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
        count += chunk.length;
        largest = Math.max(largest, chunk.length);
        expect(chunk[0]).toBe(37);
      }
    });
    expect(count).toBe(2 * 1024 * 1024);
    expect(largest).toBeLessThanOrEqual(65536);
    await expect(opened!.stat()).rejects.toThrow();
  });

  it('captures the storage root and raw record before the first filesystem await', async () => {
    const pending = read((handle) => handle.readFile());
    storage.options.documentRoot = directory;
    record.path = '..';
    record.filename = 'not-the-attachment';
    record.size = 0;
    await expect(pending).resolves.toEqual(bytes);
  });

  it('uses the opened object rather than reopening a replaced path during consumption', async () => {
    await read(async (handle) => {
      await fs.rename(location(), path.join(directory, 'original'));
      await fs.writeFile(location(), 'replacement content');
      expect(await handle.readFile()).toEqual(bytes);
    });
    expect(await fs.readFile(location(), 'utf8')).toBe('replacement content');
  });

  it.each(['../tenants/B', '/tenants/B', 'C:/tenants/B', 'tenants\\B', 'tenants//B', 'tenants/./B'])(
    'rejects unsafe stored directory %j without consuming bytes',
    async (value) => {
      record.path = value;
      await refused();
    },
  );

  it.each(['../receipt.txt', '/receipt.txt', 'receipt.txt:secret', 'receipt.txt ', 'NUL', 'CON.txt', 'a\0.txt'])(
    'rejects unsafe stored filename %j',
    async (value) => {
      record.filename = value;
      await refused();
    },
  );

  it.each([-1, 0, bytes.length - 1, bytes.length + 1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    'rejects invalid or mismatched stored size %j',
    async (value) => {
      record.size = value;
      await refused();
    },
  );

  it('permits a genuinely empty file and the storage root as its directory', async () => {
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    record = { path: '', filename: 'empty.txt', storageId: 18, size: 0 };
    await expect(read((handle) => handle.readFile())).resolves.toEqual(Buffer.alloc(0));
  });

  it('rejects a record belonging to another storage', async () => {
    record.storageId = 19;
    await refused();
  });

  it('does not treat a cloud storage as a local filesystem root', async () => {
    storage.type = 's3';
    await refused();
  });

  it('rejects a directory junction to an otherwise valid attachment', async () => {
    const previous = path.join(directory, 'previous');
    await fs.rename(path.join(root, 'tenants/B'), previous);
    await fs.symlink(previous, path.join(root, 'tenants/B'), 'junction');
    await refused();
  });

  it('rejects hard-linked content rather than borrowing an outside object', async () => {
    await fs.link(location(), path.join(directory, 'outside-link'));
    await refused();
    expect(await fs.readFile(path.join(directory, 'outside-link'))).toEqual(bytes);
  });

  it('rejects a directory in place of the record file', async () => {
    await fs.unlink(location());
    await fs.mkdir(location());
    let consumed = false;
    await expect(
      read(async () => {
        consumed = true;
      }),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
  });

  it('rejects an object replaced between the initial stat and opening and closes the opened handle', async () => {
    const actualOpen = fs.open.bind(fs);
    let opened: FileHandle;
    const intercept = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(location(), path.join(directory, 'previous-object'));
      await fs.writeFile(location(), bytes);
      opened = await actualOpen(...args);
      return opened;
    });
    try {
      await refused();
      await expect(opened!.stat()).rejects.toThrow();
    } finally {
      intercept.mockRestore();
    }
  });

  it('rejects a replaced root even if the opened file and descendant directories are preserved', async () => {
    const actualOpen = fs.open.bind(fs);
    let opened: FileHandle;
    const intercept = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const previous = path.join(directory, 'previous-root');
      await fs.rename(root, previous);
      await fs.mkdir(root);
      await fs.rename(path.join(previous, 'tenants'), path.join(root, 'tenants'));
      opened = await actualOpen(...args);
      return opened;
    });
    try {
      await refused();
      await expect(opened!.stat()).rejects.toThrow();
    } finally {
      intercept.mockRestore();
    }
  });

  it('does not invoke location accessors while capturing raw stored metadata', async () => {
    let invoked = false;
    Object.defineProperty(record, 'filename', {
      enumerable: true,
      get() {
        invoked = true;
        return 'receipt.txt';
      },
    });
    await refused();
    expect(invoked).toBe(false);
  });

  it('does not create a missing stored object', async () => {
    record.filename = 'missing.txt';
    await refused();
    await expect(fs.stat(path.join(root, 'tenants/B/missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
