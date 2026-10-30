import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Destructive dependency characterization ONLY of new unique fixtures, never stored attachments.
describe.skipIf(process.platform !== 'win32')('native handle delete disposition boundaries', () => {
  let directory: string;
  let root: string;
  let parent: string;
  let file: string;
  const original = Buffer.from('New isolated disposition fixture bytes');
  const children = new Set<{ child: ReturnType<typeof spawn>; closed: Promise<{ code: number; signal: string }> }>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-native-disposition-'));
    root = path.join(directory, 'root');
    parent = path.join(root, 'nested');
    await fs.mkdir(parent, { recursive: true });
    file = path.join(parent, 'attachment.txt');
    await fs.writeFile(file, original, { flag: 'wx' });
  });

  afterEach(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    children.clear();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  const identity = async (filename: string) => {
    const stat = await fs.lstat(filename, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      size: String(stat.size),
      nlink: String(stat.nlink),
    };
  };

  const capture = async () => ({
    file: await identity(file),
    directories: await Promise.all([root, parent].map(identity)),
  });

  async function guard(expected: Awaited<ReturnType<typeof capture>>, fixtureDirectory = directory) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-native-disposition.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEGO_DISPOSITION_FIXTURE_DIRECTORY: fixtureDirectory,
        TEGO_DISPOSITION_FIXTURE_EXPECTED: JSON.stringify(expected),
      },
    });
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (value: string) => {
      diagnostics += value;
    });
    child.stdin.on('error', (error) => {
      diagnostics += String(error);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const closed = new Promise<{ code: number; signal: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    void closed.catch(() => {});
    children.add({ child, closed });
    const next = async () => {
      const result = await lines.next();
      return result.done ? 'closed' : result.value;
    };
    let status = await next();
    return {
      ready: status,
      async command(value: string) {
        child.stdin.write(value + '\n');
        status = await next();
        return status;
      },
      async release() {
        if (['held', 'validated', 'marked'].includes(status)) child.stdin.end('release\n');
        const result = await closed;
        if (result.code !== 0) throw new Error('Native disposition fixture failed: ' + diagnostics);
      },
      async terminate() {
        child.kill();
        await closed;
      },
      async finished() {
        return closed;
      },
    };
  }

  it('marks only the captured open object and removes its original name after closing', async () => {
    const held = await guard(await capture());
    try {
      expect(held.ready).toBe('held');
      expect(await held.command('mark')).toBe('marked');
    } finally {
      await held.release();
    }
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(file, 'a later object reuses the old name', { flag: 'wx' });
    expect(await fs.readFile(file, 'utf8')).toBe('a later object reuses the old name');
  });

  it('rejects a nested path outside its unique fixture namespace before acquiring deletion access', async () => {
    const held = await guard(await capture(), root);
    expect(held.ready).toBe('closed');
    expect((await held.finished()).code).not.toBe(0);
    expect(await fs.readFile(file)).toEqual(original);
  });

  it('retains a read-only fixture rather than clearing attributes or falling back to path deletion', async () => {
    await fs.chmod(file, 0o444);
    try {
      const held = await guard(await capture());
      try {
        expect(held.ready).toBe('held');
        expect(await held.command('mark')).toBe('rejected:5');
      } finally {
        await held.release();
      }
      expect(await fs.readFile(file)).toEqual(original);
    } finally {
      await fs.chmod(file, 0o666);
    }
  });

  it('rejects an equal-content replacement before acquisition without deleting either object', async () => {
    const expected = await capture();
    const retained = path.join(parent, 'retained.txt');
    await fs.rename(file, retained);
    await fs.writeFile(file, original, { flag: 'wx' });
    const held = await guard(expected);
    expect(held.ready).toBe('rejected:identity');
    await held.release();
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(retained)).toEqual(original);
  });

  it('refuses disposition if a new hardlink appears after acquisition but before the final check', async () => {
    const held = await guard(await capture());
    const alias = path.join(root, 'alias.txt');
    try {
      expect(held.ready).toBe('held');
      await fs.link(file, alias);
      expect(await held.command('mark')).toBe('rejected:identity');
    } finally {
      await held.release();
    }
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(alias)).toEqual(original);
  });

  it('refuses disposition after timestamp drift without consuming the original object', async () => {
    const held = await guard(await capture());
    try {
      expect(held.ready).toBe('held');
      await fs.utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
      expect(await held.command('mark')).toBe('rejected:identity');
    } finally {
      await held.release();
    }
    expect(await fs.readFile(file)).toEqual(original);
  });

  it('retains the new fixture if the helper dies before setting any delete disposition', async () => {
    const expected = await capture();
    const held = await guard(expected);
    expect(held.ready).toBe('held');
    await held.terminate();
    expect(await fs.readFile(file)).toEqual(original);
    const after = await identity(file);
    expect([after.dev, after.ino, after.birthtimeNs]).toEqual([
      expected.file.dev,
      expected.file.ino,
      expected.file.birthtimeNs,
    ]);
  });

  it('can delete after native success even when the helper exits before sending any acknowledgment', async () => {
    const held = await guard(await capture());
    expect(held.ready).toBe('held');
    expect(await held.command('mark-exit-before-reply')).toBe('closed');
    expect((await held.finished()).code).toBe(0);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(file, 'do not retry deletion against this replacement', { flag: 'wx' });
    expect(await fs.readFile(file, 'utf8')).toBe('do not retry deletion against this replacement');
  });

  it('does not equate successful disposition with immediate name reuse while another reader remains open', async () => {
    const reader = await fs.open(file, 'r');
    try {
      const held = await guard(await capture());
      try {
        expect(held.ready).toBe('held');
        expect(await held.command('mark')).toBe('marked');
      } finally {
        await held.release();
      }
      expect(await reader.readFile()).toEqual(original);
      await expect(
        (async () => {
          const handle = await fs.open(file, 'wx');
          await handle.close();
        })(),
      ).rejects.toThrow();
    } finally {
      await reader.close();
    }
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(file, 'name reusable after the last reader closes', { flag: 'wx' });
  });

  it('leaves bytes reachable through a hardlink inserted after a split identity check', async () => {
    const held = await guard(await capture());
    const alias = path.join(root, 'after-check-alias.txt');
    try {
      expect(held.ready).toBe('held');
      expect(await held.command('validate-only')).toBe('validated');
      await fs.link(file, alias);
      expect(await held.command('mark-without-recheck')).toBe('marked');
    } finally {
      await held.release();
    }
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(alias)).toEqual(original);
    expect((await identity(alias)).nlink).toBe('1');
  });
});
