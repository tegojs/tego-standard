import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface RootObservation {
  state: string;
  openedVia: string;
  dev: string;
  ino: string;
  volumeGuid: string;
  volumeSerial: string;
  fileId128: string;
}

// Physical alias coalescing for new fixtures only, not authenticated deployment admission.
describe.skipIf(process.platform !== 'win32')('Windows physical root alias admission', () => {
  let directory: string;
  let rootIdentity: { dev: string; ino: string };
  let otherIdentity: { dev: string; ino: string };
  const children = new Set<ReturnType<typeof launch>>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-root-alias-'));
    for (const name of ['root', 'other']) {
      await fs.mkdir(path.join(directory, name));
      await fs.writeFile(path.join(directory, name, 'probe.txt'), 'Fresh root-alias ' + name + ' fixture\n', {
        flag: 'wx',
      });
    }
    rootIdentity = await identity('root');
    otherIdentity = await identity('other');
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

  async function identity(name: string) {
    const stat = await fs.stat(path.join(directory, name), { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }

  function launch(mode: string) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-root-alias.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TEGO_ROOT_ALIAS_DIRECTORY: directory, TEGO_ROOT_ALIAS_MODE: mode },
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
      throw new Error('Missing native reply: ' + JSON.stringify(await session.closed) + session.diagnostics());
    return next.value;
  }

  function checkIdentity(observation: RootObservation, name: 'root' | 'other', openedVia: string) {
    const expected = name === 'root' ? rootIdentity : otherIdentity;
    expect(observation).toMatchObject({ ...expected, openedVia });
    expect(observation.volumeGuid).toMatch(/^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/);
    expect(observation.volumeSerial).toMatch(/^[1-9][0-9]*$/);
    expect(observation.fileId128).toMatch(/^[A-F0-9]{32}$/);
    expect(observation.fileId128).not.toBe('00000000000000000000000000000000');
    expect(Object.keys(observation).sort()).toEqual([
      'dev',
      'fileId128',
      'ino',
      'openedVia',
      'state',
      'volumeGuid',
      'volumeSerial',
    ]);
  }

  async function closed(session: ReturnType<typeof launch>, code = 0) {
    expect((await session.lines.next()).done).toBe(true);
    expect(await session.closed).toEqual({ code, signal: null });
    expect(session.diagnostics()).toBe('');
  }

  async function holder(mode: 'hold-dos-root' | 'hold-guid-root') {
    const session = launch(mode);
    const observation = JSON.parse(await read(session)) as RootObservation;
    expect(observation.state).toBe('held');
    checkIdentity(observation, 'root', mode === 'hold-guid-root' ? 'volume-guid' : 'dos');
    return { session, observation };
  }

  async function probe(mode: 'probe-guid-root' | 'probe-dos-root' | 'probe-dos-other', state: string) {
    const session = launch(mode);
    session.child.stdin.end();
    const observation = JSON.parse(await read(session)) as RootObservation;
    expect(observation.state).toBe(state);
    checkIdentity(
      observation,
      mode === 'probe-dos-other' ? 'other' : 'root',
      mode === 'probe-guid-root' ? 'volume-guid' : 'dos',
    );
    await closed(session);
    return observation;
  }

  function physical(observation: RootObservation) {
    return [observation.volumeGuid, observation.volumeSerial, observation.fileId128];
  }

  async function release(session: ReturnType<typeof launch>) {
    session.child.stdin.end('release-and-close\n');
    expect(await read(session)).toBe('released');
    await closed(session);
  }

  async function preserved() {
    expect(await identity('root')).toEqual(rootIdentity);
    expect(await identity('other')).toEqual(otherIdentity);
    for (const name of ['root', 'other']) {
      expect(await fs.readFile(path.join(directory, name, 'probe.txt'), 'utf8')).toBe(
        'Fresh root-alias ' + name + ' fixture\n',
      );
    }
  }

  it('coalesces a volume GUID contender with a DOS-root holder before and after release', async () => {
    const { session, observation } = await holder('hold-dos-root');
    expect(physical(await probe('probe-guid-root', 'busy'))).toEqual(physical(observation));
    await release(session);
    expect(physical(await probe('probe-guid-root', 'acquired'))).toEqual(physical(observation));
    await preserved();
  });

  it('coalesces a DOS contender with a root held through its actual volume GUID alias', async () => {
    const { session, observation } = await holder('hold-guid-root');
    expect(physical(await probe('probe-dos-root', 'busy'))).toEqual(physical(observation));
    await release(session);
    expect(physical(await probe('probe-dos-root', 'acquired'))).toEqual(physical(observation));
    await preserved();
  });

  it('does not merge another physical directory merely because it is on the same volume', async () => {
    const { session, observation } = await holder('hold-dos-root');
    const other = await probe('probe-dos-other', 'acquired');
    expect([other.volumeGuid, other.volumeSerial]).toEqual([observation.volumeGuid, observation.volumeSerial]);
    expect(other.fileId128).not.toBe(observation.fileId128);
    expect(physical(await probe('probe-guid-root', 'busy'))).toEqual(physical(observation));
    await release(session);
    await preserved();
  });

  it('rejects an unknown mode before emitting a root observation', async () => {
    const session = launch('delete');
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await closed(session, 2);
    await preserved();
  });

  it('rejects an extra namespace entry before acquiring root admission', async () => {
    await fs.writeFile(path.join(directory, 'sentinel.txt'), 'new alias fixture sentinel', { flag: 'wx' });
    const session = launch('hold-dos-root');
    session.child.stdin.end();
    expect(await read(session)).toBe('rejected:fixture-boundary');
    await closed(session, 2);
    await preserved();
    expect(await fs.readFile(path.join(directory, 'sentinel.txt'), 'utf8')).toBe('new alias fixture sentinel');
  });

  it('releases actual alias admission when the holder rejects an unknown command', async () => {
    const { session, observation } = await holder('hold-dos-root');
    session.child.stdin.end('delete\n');
    expect(await read(session)).toBe('rejected:command');
    await closed(session, 2);
    expect(physical(await probe('probe-guid-root', 'acquired'))).toEqual(physical(observation));
    await preserved();
  });
});
