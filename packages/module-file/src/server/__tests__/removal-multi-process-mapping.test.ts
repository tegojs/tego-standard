import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Two independently owned views, not a deployment-wide writer census or cleanup capability.
describe.skipIf(process.platform !== 'win32')('independent Windows mapped writers', () => {
  let directory: string;
  let file: string;
  let identity: { dev: string; ino: string };
  const original = Buffer.from('Fresh multi-process mapping fixture; never a business attachment\n');
  const children = new Set<ReturnType<typeof launch>>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-multi-view-'));
    file = path.join(directory, 'probe.txt');
    await fs.writeFile(file, original, { flag: 'wx' });
    const stat = await fs.stat(file, { bigint: true });
    identity = { dev: String(stat.dev), ino: String(stat.ino) };
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

  function launch(mode: string, candidate = directory) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-multi-process-mapping.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TEGO_MULTI_VIEW_DIRECTORY: candidate, TEGO_MULTI_VIEW_MODE: mode },
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
    if (next.done) {
      throw new Error('Missing native fixture reply: ' + JSON.stringify(await session.closed) + session.diagnostics());
    }
    return JSON.parse(next.value) as { state: string; dev: string; ino: string; openError?: number };
  }

  async function expectClosed(session: ReturnType<typeof launch>) {
    expect((await session.lines.next()).done).toBe(true);
    expect(await session.closed).toEqual({ code: 0, signal: null });
    expect(session.diagnostics()).toBe('');
  }

  async function hold(mode: 'hold-first' | 'hold-second') {
    const session = launch(mode);
    expect(await read(session)).toEqual({ state: 'view-held', ...identity });
    return session;
  }

  async function finish(session: ReturnType<typeof launch>) {
    session.child.stdin.end('write-and-release\n');
    expect(await read(session)).toEqual({ state: 'view-written', ...identity });
    await expectClosed(session);
  }

  async function gate(error: number) {
    const session = launch('probe-gate');
    session.child.stdin.end();
    expect(await read(session)).toEqual({ state: 'gate-observed', ...identity, openError: error });
    await expectClosed(session);
  }

  async function expectBoundary(mode: string, candidate = directory) {
    const session = launch(mode, candidate);
    session.child.stdin.end();
    expect(await session.lines.next()).toMatchObject({ value: 'rejected:fixture-boundary', done: false });
    expect((await session.lines.next()).done).toBe(true);
    expect(await session.closed).toEqual({ code: 2, signal: null });
    expect(session.diagnostics()).toBe('');
  }

  async function expectBytes(value: string) {
    expect(await fs.readFile(file)).toEqual(Buffer.from(value));
    const stat = await fs.stat(file, { bigint: true });
    expect([String(stat.dev), String(stat.ino), stat.nlink, stat.size]).toEqual([
      identity.dev,
      identity.ino,
      1n,
      BigInt(original.length),
    ]);
  }

  it('keeps admission closed after one independent holder has normally exited', async () => {
    const first = await hold('hold-first');
    const second = await hold('hold-second');
    expect(first.child.pid).not.toBe(second.child.pid);
    await finish(first);
    await expectBytes('Mresh multi-process mapping fixture; never a business attachment\n');
    await gate(32);
    await finish(second);
    await expectBytes('MSesh multi-process mapping fixture; never a business attachment\n');
    await gate(0);
  });

  it('does not drain an independent writer by terminating the other holder', async () => {
    const first = await hold('hold-first');
    const second = await hold('hold-second');
    expect(first.child.pid).not.toBe(second.child.pid);
    first.child.kill();
    expect(await first.closed).not.toEqual({ code: 0, signal: null });
    await expectBytes('Fresh multi-process mapping fixture; never a business attachment\n');
    await gate(32);
    await finish(second);
    await expectBytes('FSesh multi-process mapping fixture; never a business attachment\n');
    await gate(0);
  });

  it('rejects extra namespace entries before opening a view or changing bytes', async () => {
    await fs.writeFile(path.join(directory, 'sentinel.txt'), 'preserve this new sentinel', { flag: 'wx' });
    await expectBoundary('hold-first');
    await expectBytes('Fresh multi-process mapping fixture; never a business attachment\n');
    expect(await fs.readFile(path.join(directory, 'sentinel.txt'), 'utf8')).toBe('preserve this new sentinel');
  });

  it('rejects an unknown command instead of writing through the held view', async () => {
    const session = await hold('hold-first');
    session.child.stdin.end('delete\n');
    expect((await session.lines.next()).done).toBe(true);
    expect((await session.closed).code).not.toBe(0);
    await expectBytes('Fresh multi-process mapping fixture; never a business attachment\n');
    await gate(0);
  });

  it('rejects an unrelated direct temp directory without opening its fixed file', async () => {
    const renamed = path.join(os.tmpdir(), 'tego-multi-view-unrelated-' + path.basename(directory));
    await fs.rename(directory, renamed);
    directory = renamed;
    file = path.join(directory, 'probe.txt');
    await expectBoundary('hold-first');
    await expectBytes('Fresh multi-process mapping fixture; never a business attachment\n');
  });

  it('rejects a nested namespace even when its fixed file has the expected bytes', async () => {
    const nested = path.join(directory, 'tego-removal-multi-view-nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'probe.txt'), original, { flag: 'wx' });
    await expectBoundary('hold-first', nested);
    expect(await fs.readFile(path.join(nested, 'probe.txt'))).toEqual(original);
    await expectBytes('Fresh multi-process mapping fixture; never a business attachment\n');
  });

  it('rejects an unknown mode before opening a view or changing bytes', async () => {
    await expectBoundary('delete');
    await expectBytes('Fresh multi-process mapping fixture; never a business attachment\n');
  });
});
