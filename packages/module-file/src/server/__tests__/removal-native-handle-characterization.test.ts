import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  async function guard(directories = [root, parent]) {
    // Arguments/environment carry paths, never PowerShell source interpolation or user profiles.
    const fixture = fileURLToPath(new URL('./fixtures/removal-native-handle.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEGO_HANDLE_FIXTURE_FILE: file,
        TEGO_HANDLE_FIXTURE_DIRECTORIES: JSON.stringify(directories),
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
    const ready = await new Promise<string>((resolve, reject) => {
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
    return {
      ready,
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
});
