import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// A local handle-binding experiment, not authentication of a production storage root.
describe.skipIf(process.platform !== 'win32')('Windows directory-relative fixture reads', () => {
  let directory: string;
  const original = 'Original root-relative fixture; never a business attachment\n';
  const replacement = 'Replaced root-relative fixture; never a business attachment\n';
  const children = new Set<ReturnType<typeof launch>>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-relative-'));
    for (const [name, bytes] of [
      ['root', original],
      ['replacement', replacement],
    ]) {
      await fs.mkdir(path.join(directory, name, 'data'), { recursive: true });
      await fs.writeFile(path.join(directory, name, 'data', 'probe.txt'), bytes, { flag: 'wx' });
    }
  });

  afterEach(async () => {
    for (const session of children) {
      if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill();
      await session.closed;
      session.reader.close();
    }
    children.clear();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  function launch(candidate = directory) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-root-relative.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TEGO_RELATIVE_DIRECTORY: candidate },
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const lines = reader[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (value: string) => (stderr += value));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    void closed.catch(() => {});
    const session = { child, reader, lines, closed, diagnostics: () => stderr };
    children.add(session);
    return session;
  }

  async function identity(file: string) {
    const stat = await fs.stat(file, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }

  async function binding() {
    const root = await identity(path.join(directory, 'root'));
    const data = await identity(path.join(directory, 'root', 'data'));
    const file = await identity(path.join(directory, 'root', 'data', 'probe.txt'));
    return { rootDev: root.dev, rootIno: root.ino, dataDev: data.dev, dataIno: data.ino, ...file };
  }

  async function read(session: ReturnType<typeof launch>) {
    const next = await session.lines.next();
    if (next.done)
      throw new Error('Missing native reply: ' + JSON.stringify(await session.closed) + session.diagnostics());
    return next.value;
  }

  async function ready() {
    const expected = await binding();
    const session = launch();
    expect(JSON.parse(await read(session))).toEqual({
      state: 'root-held',
      ...expected,
      bytes: Buffer.from(original).toString('base64'),
    });
    return { session, expected };
  }

  async function closed(session: ReturnType<typeof launch>, code: number) {
    expect((await session.lines.next()).done).toBe(true);
    expect(await session.closed).toEqual({ code, signal: null });
    expect(session.diagnostics()).toBe('');
  }

  async function preserved(file: string, bytes: string, expected: { dev: string; ino: string }) {
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(await identity(file)).toEqual({ dev: expected.dev, ino: expected.ino });
    const stat = await fs.stat(file, { bigint: true });
    expect([stat.nlink, stat.size]).toEqual([1n, BigInt(Buffer.byteLength(bytes))]);
  }

  it('reads the original root after its former pathname selects a different directory', async () => {
    const { session, expected } = await ready();
    const decoy = await identity(path.join(directory, 'replacement', 'data', 'probe.txt'));
    await fs.rename(path.join(directory, 'root'), path.join(directory, 'moved'));
    await fs.rename(path.join(directory, 'replacement'), path.join(directory, 'root'));
    expect(await identity(path.join(directory, 'root'))).not.toEqual({ dev: expected.rootDev, ino: expected.rootIno });
    session.child.stdin.end('observe-and-close\n');
    expect(JSON.parse(await read(session))).toEqual({
      state: 'relative-observed',
      ...expected,
      bytes: Buffer.from(original).toString('base64'),
    });
    await closed(session, 0);
    await preserved(path.join(directory, 'moved', 'data', 'probe.txt'), original, expected);
    await preserved(path.join(directory, 'root', 'data', 'probe.txt'), replacement, decoy);
  });

  it('rejects a replaced child directory despite retaining the original root handle', async () => {
    const { session, expected } = await ready();
    const decoy = await identity(path.join(directory, 'replacement', 'data', 'probe.txt'));
    await fs.rename(path.join(directory, 'root', 'data'), path.join(directory, 'root', 'old-data'));
    await fs.rename(path.join(directory, 'replacement', 'data'), path.join(directory, 'root', 'data'));
    session.child.stdin.end('observe-and-close\n');
    expect(await read(session)).toBe('rejected:binding-change');
    await closed(session, 2);
    await preserved(path.join(directory, 'root', 'old-data', 'probe.txt'), original, expected);
    await preserved(path.join(directory, 'root', 'data', 'probe.txt'), replacement, decoy);
  });

  it('rejects a directory junction rather than following it to the replacement file', async () => {
    const { session, expected } = await ready();
    const decoy = await identity(path.join(directory, 'replacement', 'data', 'probe.txt'));
    await fs.rename(path.join(directory, 'root', 'data'), path.join(directory, 'root', 'old-data'));
    await fs.symlink(path.join(directory, 'replacement', 'data'), path.join(directory, 'root', 'data'), 'junction');
    expect((await fs.lstat(path.join(directory, 'root', 'data'))).isSymbolicLink()).toBe(true);
    session.child.stdin.end('observe-and-close\n');
    expect(await read(session)).toBe('rejected:binding-change');
    await closed(session, 2);
    await preserved(path.join(directory, 'root', 'old-data', 'probe.txt'), original, expected);
    await preserved(path.join(directory, 'replacement', 'data', 'probe.txt'), replacement, decoy);
  });

  it('rejects an unknown command without reading from a replacement path', async () => {
    const { session, expected } = await ready();
    session.child.stdin.end('delete\n');
    expect(await read(session)).toBe('rejected:command');
    await closed(session, 2);
    await preserved(path.join(directory, 'root', 'data', 'probe.txt'), original, expected);
  });

  it('rejects a replaced leaf while the original root and child directory remain', async () => {
    const { session, expected } = await ready();
    const decoy = await identity(path.join(directory, 'replacement', 'data', 'probe.txt'));
    await fs.rename(
      path.join(directory, 'root', 'data', 'probe.txt'),
      path.join(directory, 'root', 'data', 'old-probe.txt'),
    );
    await fs.rename(
      path.join(directory, 'replacement', 'data', 'probe.txt'),
      path.join(directory, 'root', 'data', 'probe.txt'),
    );
    expect(await identity(path.join(directory, 'root', 'data'))).toEqual({
      dev: expected.dataDev,
      ino: expected.dataIno,
    });
    session.child.stdin.end('observe-and-close\n');
    expect(await read(session)).toBe('rejected:binding-change');
    await closed(session, 2);
    await preserved(path.join(directory, 'root', 'data', 'old-probe.txt'), original, expected);
    await preserved(path.join(directory, 'root', 'data', 'probe.txt'), replacement, decoy);
  });

  it('rejects changed bytes on the same leaf instead of replaying the first observation', async () => {
    const { session, expected } = await ready();
    const changed = 'Modified root-relative fixture; never a business attachment\n';
    const file = path.join(directory, 'root', 'data', 'probe.txt');
    await fs.writeFile(file, changed, { flag: 'r+' });
    await preserved(file, changed, expected);
    session.child.stdin.end('observe-and-close\n');
    expect(await read(session)).toBe('rejected:binding-change');
    await closed(session, 2);
    await preserved(file, changed, expected);
  });

  it('rejects an extra namespace entry before opening the root', async () => {
    const expected = await identity(path.join(directory, 'root', 'data', 'probe.txt'));
    await fs.writeFile(path.join(directory, 'sentinel.txt'), 'new fixture sentinel', { flag: 'wx' });
    const session = launch();
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await closed(session, 2);
    await preserved(path.join(directory, 'root', 'data', 'probe.txt'), original, expected);
    expect(await fs.readFile(path.join(directory, 'sentinel.txt'), 'utf8')).toBe('new fixture sentinel');
  });

  it('rejects an unrelated direct temporary namespace before opening the root', async () => {
    const expected = await identity(path.join(directory, 'root', 'data', 'probe.txt'));
    const renamed = path.join(os.tmpdir(), 'tego-relative-unrelated-' + path.basename(directory));
    await fs.rename(directory, renamed);
    directory = renamed;
    const session = launch();
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await closed(session, 2);
    await preserved(path.join(directory, 'root', 'data', 'probe.txt'), original, expected);
  });
});
