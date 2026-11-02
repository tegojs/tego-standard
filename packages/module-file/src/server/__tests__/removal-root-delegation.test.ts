import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Test launcher authority is assumed; this does not authenticate a deployment root.
describe.skipIf(process.platform !== 'win32')('Windows inherited root capability boundaries', () => {
  let directory: string;
  const original = 'Original delegated root fixture\n';
  const decoy = 'Replaced delegated root fixture\n';
  const children = new Set<ReturnType<typeof launch>>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-root-delegation-'));
    for (const name of ['root', 'replacement']) {
      await fs.mkdir(path.join(directory, name));
      await fs.writeFile(path.join(directory, name, 'probe.txt'), name === 'root' ? original : decoy, { flag: 'wx' });
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

  async function identity(relative: string) {
    const stat = await fs.lstat(path.join(directory, relative), { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
  }

  function launch(mode = 'delegate', fixtureDirectory = directory) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-root-delegation.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TEGO_DELEGATION_DIRECTORY: fixtureDirectory, TEGO_DELEGATION_MODE: mode },
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

  async function read(session: ReturnType<typeof launch>) {
    const next = await session.lines.next();
    if (next.done)
      throw new Error('Missing delegation reply: ' + JSON.stringify(await session.closed) + session.diagnostics());
    return next.value;
  }

  async function finished(session: ReturnType<typeof launch>, code = 0) {
    expect((await session.lines.next()).done).toBe(true);
    expect(await session.closed).toEqual({ code, signal: null });
    expect(session.diagnostics()).toBe('');
  }

  async function pinned(mode = 'delegate') {
    const root = await identity('root');
    const file = await identity('root/probe.txt');
    const session = launch(mode);
    expect(JSON.parse(await read(session))).toEqual({ state: 'root-held', rootDev: root.dev, rootIno: root.ino });
    return { session, root, file };
  }

  async function delegated(held: Awaited<ReturnType<typeof pinned>>, rootName = 'root') {
    held.session.child.stdin.end('delegate-and-close\n');
    expect(JSON.parse(await read(held.session))).toEqual({
      state: 'delegated-read',
      rootDev: held.root.dev,
      rootIno: held.root.ino,
      dev: held.file.dev,
      ino: held.file.ino,
      bytes: Buffer.from(original).toString('base64'),
      attributeError: 5,
    });
    await finished(held.session);
    expect(await identity(rootName)).toEqual(held.root);
    expect(await identity(rootName + '/probe.txt')).toEqual(held.file);
    expect(await fs.readFile(path.join(directory, rootName, 'probe.txt'), 'utf8')).toBe(original);
  }

  it('delegates a reduced root handle that survives closure of both launcher copies', async () => {
    const held = await pinned();
    await delegated(held);
    expect(await fs.readFile(path.join(directory, 'replacement/probe.txt'), 'utf8')).toBe(decoy);
  });

  it('delivers the original root capability after its former path names a different directory', async () => {
    const held = await pinned();
    await fs.rename(path.join(directory, 'root'), path.join(directory, 'moved'));
    await fs.rename(path.join(directory, 'replacement'), path.join(directory, 'root'));
    const replacement = await identity('root');
    expect(replacement.ino).not.toBe(held.root.ino);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(decoy);
    await delegated(held, 'moved');
    expect(await identity('root')).toEqual(replacement);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(decoy);
  });

  it('does not turn a numeric root value into a capability when the explicit inheritance list omits it', async () => {
    const held = await pinned('omit-root');
    held.session.child.stdin.end('delegate-and-close\n');
    expect(await read(held.session)).toBe('rejected:inherited-root');
    await finished(held.session, 2);
    expect(await identity('root')).toEqual(held.root);
    expect(await identity('root/probe.txt')).toEqual(held.file);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(original);
  });

  it('reads the delegated leaf instead of returning the known original fixture bytes', async () => {
    const held = await pinned();
    expect(Buffer.byteLength(decoy)).toBe(Buffer.byteLength(original));
    await fs.writeFile(path.join(directory, 'root/probe.txt'), decoy);
    const changed = await identity('root/probe.txt');
    expect([changed.dev, changed.ino]).toEqual([held.file.dev, held.file.ino]);
    held.session.child.stdin.end('delegate-and-close\n');
    expect(await read(held.session)).toBe('rejected:binding-change');
    await finished(held.session, 2);
    expect(await identity('root/probe.txt')).toEqual(changed);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(decoy);
  });

  it('rejects an unknown launcher command without delegating the root', async () => {
    const held = await pinned();
    held.session.child.stdin.end('delete\n');
    expect(await read(held.session)).toBe('rejected:command');
    await finished(held.session, 2);
    expect(await identity('root')).toEqual(held.root);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(original);
  });

  it('rejects an unknown mode before holding a root', async () => {
    const session = launch('delete');
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await finished(session, 2);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(original);
  });

  it('rejects a nested namespace before holding a root', async () => {
    const session = launch('delegate', path.join(directory, 'root'));
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await finished(session, 2);
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(original);
  });

  it('rejects an extra namespace entry before holding a root', async () => {
    await fs.writeFile(path.join(directory, 'sentinel.txt'), 'Fresh delegation sentinel', { flag: 'wx' });
    const session = launch();
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await finished(session, 2);
    expect(await fs.readFile(path.join(directory, 'sentinel.txt'), 'utf8')).toBe('Fresh delegation sentinel');
    expect(await fs.readFile(path.join(directory, 'root/probe.txt'), 'utf8')).toBe(original);
  });
});
