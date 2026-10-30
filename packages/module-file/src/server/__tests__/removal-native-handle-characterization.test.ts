import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface NativeIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string;
  mtimeNs: string;
  ctimeNs: string;
  size: string;
  nlink: string;
  directory: boolean;
  reparse: boolean;
}

interface NativeObservation {
  file: NativeIdentity;
  directories: NativeIdentity[];
}

// Windows dependency characterization, not a production helper, lease or removal implementation.
describe.skipIf(process.platform !== 'win32')('native Windows attachment handle boundaries', () => {
  let directory: string;
  let root: string;
  let parent: string;
  let file: string;
  const original = Buffer.from('Only isolated fixture bytes, never a business attachment');
  const children = new Set<ReturnType<typeof spawn>>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-native-handle-'));
    root = path.join(directory, 'root');
    parent = path.join(root, 'nested');
    await fs.mkdir(parent, { recursive: true });
    file = path.join(parent, 'attachment.txt');
    await fs.writeFile(file, original, { flag: 'wx' });
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill();
        await closed;
      }
    }
    children.clear();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  const nodeIdentity = async (filename: string): Promise<NativeIdentity> => {
    const stat = await fs.lstat(filename, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      size: String(stat.size),
      nlink: String(stat.nlink),
      directory: stat.isDirectory(),
      reparse: stat.isSymbolicLink(),
    };
  };

  async function guard(directories = [root, parent], nativeIdentity = false) {
    // Arguments/environment carry paths, never PowerShell source interpolation or user profiles.
    const fixture = fileURLToPath(new URL('./fixtures/removal-native-handle.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEGO_HANDLE_FIXTURE_FILE: file,
        TEGO_HANDLE_FIXTURE_DIRECTORIES: JSON.stringify(directories),
        TEGO_HANDLE_FIXTURE_NATIVE_IDENTITY: nativeIdentity ? '1' : '0',
      },
    });
    children.add(child);
    let output = '';
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (value: string) => {
      diagnostics += value;
    });
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Native handle fixture exited ' + code + ': ' + diagnostics));
      });
    });
    void completed.catch(() => {});
    const status = await new Promise<string>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (value: string) => {
        output += value;
        if (output.includes('\n')) resolve(output.split(/\r?\n/)[0]);
      });
      child.once('error', reject);
      child.once('close', () => {
        if (!output.includes('\n')) reject(new Error('No native handle readiness: ' + diagnostics));
      });
    });
    const ready = status.startsWith('held:') ? 'held' : status;
    return {
      ready,
      observation: status.startsWith('held:') ? (JSON.parse(status.slice(5)) as NativeObservation) : undefined,
      async observe(): Promise<NativeObservation> {
        if (!nativeIdentity || ready !== 'held') throw new Error('No live native identity fixture');
        return new Promise((resolve, reject) => {
          let response = '';
          const cleanup = () => {
            child.stdout.off('data', data);
            child.off('error', failed);
            child.off('close', closed);
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          const closed = () => failed(new Error('Native identity fixture closed before observation'));
          const data = (value: string) => {
            response += value;
            if (!response.includes('\n')) return;
            cleanup();
            try {
              resolve(JSON.parse(response.split(/\r?\n/)[0]));
            } catch (error) {
              reject(error);
            }
          };
          child.stdout.on('data', data);
          child.once('error', failed);
          child.once('close', closed);
          child.stdin.write('inspect\n', (error) => {
            if (error) failed(error);
          });
        });
      },
      async release() {
        if (ready === 'held') child.stdin.end('release\n');
        await completed;
      },
      async terminate() {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill();
        await closed;
      },
    };
  }

  it.each(['r+', 'a', 'w'])('refuses acquisition while a pre-existing %s writer remains open', async (flags) => {
    const writer = await fs.open(file, flags);
    try {
      const held = await guard();
      expect(held.ready).toBe('rejected:32');
      await held.release();
      await writer.write(Buffer.from('writer is still usable'), 0, 22, 0);
      await writer.sync();
      expect((await writer.stat()).size).toBeGreaterThan(0);
    } finally {
      await writer.close();
    }
    const held = await guard();
    expect(held.ready).toBe('held');
    await held.release();
  });

  it.each(['write', 'truncate', 'unlink', 'rename'])(
    'denies a new Node %s while the native file handle is held',
    async (operation) => {
      const before = await fs.stat(file, { bigint: true });
      const held = await guard();
      try {
        expect(held.ready).toBe('held');
        const modify = () => {
          if (operation === 'write') return fs.writeFile(file, 'changed');
          if (operation === 'truncate') return fs.truncate(file, 1);
          if (operation === 'unlink') return fs.unlink(file);
          return fs.rename(file, path.join(parent, 'moved.txt'));
        };
        await expect(modify()).rejects.toMatchObject({ code: 'EBUSY' });
        expect(await fs.readFile(file)).toEqual(original);
        const after = await fs.stat(file, { bigint: true });
        expect([after.dev, after.ino, after.birthtimeNs, after.size]).toEqual([
          before.dev,
          before.ino,
          before.birthtimeNs,
          before.size,
        ]);
      } finally {
        await held.release();
      }
      await fs.writeFile(file, 'writes resume after the native handle closes');
    },
  );

  it('does not acquire through an already open exclusive native guard', async () => {
    const first = await guard();
    try {
      expect(first.ready).toBe('held');
      const second = await guard();
      expect(second.ready).toBe('rejected:32');
      await second.release();
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await first.release();
    }
  });

  it('allows an existing ordinary Node reader without granting a writer', async () => {
    const reader = await fs.open(file, 'r');
    try {
      const held = await guard();
      try {
        expect(held.ready).toBe('held');
        expect(await reader.readFile()).toEqual(original);
        await expect(fs.writeFile(file, 'changed')).rejects.toMatchObject({ code: 'EBUSY' });
      } finally {
        await held.release();
      }
    } finally {
      await reader.close();
    }
  });

  it.each(['parent', 'root'])('pins the actual %s directory against replacement while held', async (which) => {
    const held = await guard();
    const target = which === 'parent' ? parent : root;
    const moved = target + '.moved';
    try {
      expect(held.ready).toBe('held');
      await expect(fs.rename(target, moved)).rejects.toMatchObject({ code: 'EPERM' });
      await expect(fs.stat(moved)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
    await fs.rename(target, moved);
    expect(await fs.readFile(path.join(moved, which === 'parent' ? '' : 'nested', 'attachment.txt'))).toEqual(original);
  });

  it('releases native exclusion on helper death, so a persisted UUID or old readiness is not a lease', async () => {
    const held = await guard();
    expect(held.ready).toBe('held');
    await held.terminate();
    await fs.writeFile(file, 'writes resume after helper exit');
    expect(await fs.readFile(file, 'utf8')).toBe('writes resume after helper exit');
    await fs.rename(parent, parent + '.moved');
  });

  it('reads exact decimal identity and timestamps from the held native file and directory handles', async () => {
    const expected = {
      file: await nodeIdentity(file),
      directories: await Promise.all([root, parent].map(nodeIdentity)),
    };
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      expect(held.observation).toEqual(expected);
      expect(await held.observe()).toEqual(expected);
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
  });

  it('identifies a same-content file substitution made before native acquisition', async () => {
    const expected = await nodeIdentity(file);
    const retained = path.join(parent, 'retained-original.txt');
    await fs.rename(file, retained);
    await fs.writeFile(file, original, { flag: 'wx' });
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      expect(held.observation.file).toEqual(await nodeIdentity(file));
      expect(held.observation.file.ino).not.toBe(expected.ino);
      expect(await fs.readFile(retained)).toEqual(original);
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
  });

  it('identifies a parent directory substitution rather than trusting its unchanged path', async () => {
    const expected = await nodeIdentity(parent);
    const retained = parent + '.retained';
    await fs.rename(parent, retained);
    await fs.mkdir(parent);
    await fs.writeFile(file, original, { flag: 'wx' });
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      expect(held.observation.directories[1]).toEqual(await nodeIdentity(parent));
      expect(held.observation.directories[1].ino).not.toBe(expected.ino);
      expect(await fs.readFile(path.join(retained, 'attachment.txt'))).toEqual(original);
    } finally {
      await held.release();
    }
  });

  it('exposes existing hardlink count and excludes writes through another name for that object', async () => {
    const alias = path.join(root, 'alias.txt');
    await fs.link(file, alias);
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      expect(held.observation.file.nlink).toBe('2');
      expect(held.observation.file.ino).toBe((await nodeIdentity(alias)).ino);
      await expect(fs.writeFile(alias, 'changed')).rejects.toMatchObject({ code: 'EBUSY' });
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
  });

  it('allows a new hardlink while held, so sharing denial is not stable single-link ownership', async () => {
    const alias = path.join(root, 'new-alias.txt');
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      expect(held.observation.file.nlink).toBe('1');
      await fs.link(file, alias);
      const observed = (await held.observe()).file;
      expect(observed.nlink).toBe('2');
      expect(observed.ino).toBe(held.observation.file.ino);
      expect((await nodeIdentity(alias)).ino).toBe(observed.ino);
      await expect(fs.writeFile(alias, 'changed')).rejects.toMatchObject({ code: 'EBUSY' });
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
    await fs.writeFile(alias, 'the extra link survives handle release');
    expect(await fs.readFile(file, 'utf8')).toBe('the extra link survives handle release');
  });

  it('exposes a junction directory even when the final file still matches the original object', async () => {
    const expected = await nodeIdentity(file);
    const retained = parent + '.retained';
    await fs.rename(parent, retained);
    await fs.symlink(retained, parent, 'junction');
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      expect(held.observation.directories[1].reparse).toBe(true);
      expect(held.observation.file.ino).toBe(expected.ino);
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
  });

  it('reobserves timestamp changes that sharing denial does not prevent', async () => {
    const held = await guard([root, parent], true);
    try {
      expect(held.ready).toBe('held');
      const before = held.observation.file;
      await fs.utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
      const after = (await held.observe()).file;
      expect(after).toEqual(await nodeIdentity(file));
      expect(after.ino).toBe(before.ino);
      expect(after.birthtimeNs).toBe(before.birthtimeNs);
      expect(after.mtimeNs).toBe('1577836800000000000');
      expect(after.mtimeNs).not.toBe(before.mtimeNs);
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await held.release();
    }
  });

  it('does not create or follow a missing final file when acquiring native handles', async () => {
    const retained = path.join(parent, 'retained-original.txt');
    await fs.rename(file, retained);
    const held = await guard([root, parent], true);
    expect(held.ready).toBe('rejected:2');
    await held.release();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(retained)).toEqual(original);
  });
});
