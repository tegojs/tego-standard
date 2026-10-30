import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

interface Reply {
  version: number;
  kind: string;
  requestId?: string;
  challenge?: string;
  sessionId?: string;
  reason?: string;
  peerProcessId?: number;
  brokerProcessId?: number;
  observations?: { file: Record<string, string | boolean>; directories: Record<string, string | boolean>[] };
}

// NEW FIXTURES ONLY: read-only native observations, never an attachment cleanup permit/executor.
describe.skipIf(process.platform !== 'win32')('bound pipe and native fixture session', () => {
  let directory: string;
  let root: string;
  let parent: string;
  let file: string;
  const bytes = Buffer.from('New pipe-session attachment fixture, never deleted by the broker');
  const processes = new Set<{ child: ReturnType<typeof spawn>; closed: Promise<number | null> }>();
  const sockets = new Set<net.Socket>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-session-'));
    root = path.join(directory, 'root');
    parent = path.join(root, 'nested');
    await fs.mkdir(parent, { recursive: true });
    file = path.join(parent, 'attachment.txt');
    await fs.writeFile(file, bytes, { flag: 'wx' });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const { child, closed } of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    processes.clear();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  async function identity(filename: string) {
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
  }

  const capture = async () => ({
    file: await identity(file),
    directories: await Promise.all([directory, root, parent].map(identity)),
  });

  async function broker(expected = capture()) {
    const pipeName = 'tego-removal-session-' + randomUUID();
    const pipePath = '\\\\.\\pipe\\' + pipeName;
    const fixture = fileURLToPath(new URL('./fixtures/removal-session.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        TEGO_SESSION_FIXTURE_DIRECTORY: directory,
        TEGO_SESSION_FIXTURE_PIPE: pipeName,
        TEGO_SESSION_FIXTURE_EXPECTED: JSON.stringify(await expected),
      },
    });
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (value: string) => {
      diagnostics += value;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    void closed.catch(() => {});
    processes.add({ child, closed });
    const deadline = Date.now() + 8000;
    let socket: net.Socket;
    // Startup discovery only, never reconnect or retry an established session/command.
    for (;;) {
      try {
        socket = await new Promise<net.Socket>((resolve, reject) => {
          const candidate = net.createConnection(pipePath);
          candidate.once('error', (error) => {
            candidate.destroy();
            reject(error);
          });
          candidate.once('connect', () => resolve(candidate));
        });
        break;
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
          throw new Error('Fixture pipe startup failed: ' + String(error) + '\n' + diagnostics);
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await delay(25);
      }
    }
    sockets.add(socket);
    socket.on('error', (error) => {
      diagnostics += String(error);
    });
    const reader = createInterface({ input: socket, crlfDelay: Infinity });
    reader.on('error', (error) => {
      diagnostics += String(error);
    });
    const lines = reader[Symbol.asyncIterator]();
    const next = async (): Promise<Reply | null> => {
      const line = await lines.next();
      return line.done ? null : JSON.parse(line.value);
    };
    const raw = async (message: Record<string, unknown>) => {
      socket.write(JSON.stringify(message) + '\n');
      return next();
    };
    const hello = { version: 1, kind: 'hello', requestId: randomUUID(), challenge: randomUUID() };
    const ready = await raw(hello);
    const request = async (kind = 'observe', overrides: Record<string, unknown> = {}) => {
      const message = {
        version: 1,
        kind,
        requestId: randomUUID(),
        challenge: hello.challenge,
        sessionId: ready.sessionId,
        ...overrides,
      };
      return { message, reply: await raw(message) };
    };
    return {
      ready,
      hello,
      raw,
      next,
      request,
      pid: child.pid,
      async frame(value: string) {
        socket.write(value);
        return next();
      },
      async pipeline(messages: Record<string, unknown>[]) {
        const received: string[] = [];
        const collect = (line: string) => received.push(line);
        reader.on('line', collect);
        const disconnected = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        let writeError: string | undefined;
        // A terminal broker can close before consuming the queued tail; do not mistake write EOF for a reply.
        socket.write(messages.map((message) => JSON.stringify(message) + '\n').join(''), (error) => {
          writeError = (error as NodeJS.ErrnoException | undefined)?.code;
        });
        await disconnected;
        reader.off('line', collect);
        return { replies: received.map((line): Reply => JSON.parse(line)), writeError };
      },
      async release() {
        if (ready.kind === 'held' && !socket.destroyed) await request('close');
        const code = await closed;
        if (code !== 0) throw new Error('Fixture session failed: ' + diagnostics);
      },
      async disconnect() {
        socket.end();
        const code = await closed;
        if (code !== 0) throw new Error('Fixture EOF failed: ' + diagnostics);
      },
      async terminate() {
        child.kill();
        await closed;
      },
      finished: () => closed,
    };
  }

  it('binds the actual pipe peer and one live file plus the entire new-fixture chain to correlated observations', async () => {
    const expected = await capture();
    const held = await broker(Promise.resolve(expected));
    expect(held.ready).toMatchObject({
      version: 1,
      kind: 'held',
      requestId: held.hello.requestId,
      challenge: held.hello.challenge,
      peerProcessId: process.pid,
      brokerProcessId: held.pid,
    });
    expect(held.ready.observations.file).toEqual(expected.file);
    expect(held.ready.observations.directories).toHaveLength(3);
    expected.directories.forEach(({ dev, ino, birthtimeNs }, index) => {
      expect(held.ready.observations.directories[index]).toMatchObject({ dev, ino, birthtimeNs, directory: true });
    });
    const { message, reply } = await held.request();
    expect(reply).toMatchObject({ kind: 'observed', requestId: message.requestId, sessionId: held.ready.sessionId });
    expect(reply.observations.file).toEqual(expected.file);
    expect(JSON.stringify(reply)).not.toContain(directory);
    await held.release();
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  describe('terminal read-only request', () => {
    it('returns one correlated live observation and ends the original broker without a separate close request', async () => {
      const expected = await capture();
      const held = await broker(Promise.resolve(expected));
      const { message, reply } = await held.request('finish-read-only');
      expect(reply).toMatchObject({
        version: 1,
        kind: 'read-only-finished',
        requestId: message.requestId,
        challenge: held.hello.challenge,
        sessionId: held.ready.sessionId,
        peerProcessId: process.pid,
        brokerProcessId: held.pid,
      });
      expect(reply.observations.file).toEqual(expected.file);
      expect(reply.observations.directories).toHaveLength(3);
      expect(JSON.stringify(reply)).not.toContain(directory);
      expect(await held.next()).toBeNull();
      expect(await held.finished()).toBe(0);
      const writer = await fs.open(file, 'r+');
      await writer.close();
      const later = await broker();
      expect(later.ready.kind).toBe('held');
      await later.release();
      expect(await fs.readFile(file)).toEqual(bytes);
    });

    it('does not accept pipelined new-id requests after its terminal read-only observation', async () => {
      const held = await broker();
      const messages = ['finish-read-only', 'finish-read-only', 'observe'].map((kind) => ({
        version: 1,
        kind,
        requestId: randomUUID(),
        challenge: held.hello.challenge,
        sessionId: held.ready.sessionId,
      }));
      const { replies, writeError } = await held.pipeline(messages);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ kind: 'read-only-finished', requestId: messages[0].requestId });
      expect([undefined, 'EOF']).toContain(writeError);
      expect(await held.finished()).toBe(0);
      expect(await fs.readFile(file)).toEqual(bytes);
    });

    it('rechecks native identity before finishing and ends on actual metadata drift', async () => {
      const held = await broker();
      const before = await fs.lstat(file, { bigint: true });
      await fs.utimes(file, 1700000000, 1700000000);
      expect((await fs.lstat(file, { bigint: true })).mtimeNs).not.toBe(before.mtimeNs);
      const { reply } = await held.request('finish-read-only');
      expect(reply).toMatchObject({ kind: 'rejected', reason: 'identity' });
      expect(reply).not.toHaveProperty('observations');
      expect(await held.next()).toBeNull();
      expect(await held.finished()).toBe(0);
      const writer = await fs.open(file, 'r+');
      await writer.close();
      const later = await broker();
      expect(later.ready.kind).toBe('held');
      await later.release();
      expect(await fs.readFile(file)).toEqual(bytes);
    });
  });

  it('takes root admission before opening native sessions and closes a busy peer without a session', async () => {
    const held = await broker();
    expect(held.ready.kind).toBe('held');
    const other = await broker();
    expect(other.ready).toMatchObject({ kind: 'rejected', reason: 'busy' });
    expect(other.ready.sessionId).toBeUndefined();
    expect(await other.finished()).toBe(0);
    await held.release();
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('does not leak root admission when an existing writable handle prevents native acquisition', async () => {
    const writer = await fs.open(file, 'r+');
    try {
      const refused = await broker();
      expect(refused.ready).toMatchObject({ kind: 'rejected', reason: 'native' });
      expect(await refused.finished()).toBe(0);
    } finally {
      await writer.close();
    }
    const later = await broker();
    expect(later.ready.kind).toBe('held');
    await later.release();
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('terminates the live session on a repeated request rather than accepting replay', async () => {
    const held = await broker();
    const first = await held.request();
    expect(first.reply.kind).toBe('observed');
    expect(await held.raw(first.message)).toMatchObject({ kind: 'rejected', reason: 'replay' });
    expect(await held.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('does not reconstruct a killed broker session from its historical session id', async () => {
    const held = await broker();
    expect(held.ready.kind).toBe('held');
    const oldSession = held.ready.sessionId;
    await held.terminate();
    const later = await broker();
    expect(later.ready.kind).toBe('held');
    expect(later.ready.sessionId).not.toBe(oldSession);
    const refused = await later.request('observe', { sessionId: oldSession });
    expect(refused.reply).toMatchObject({ kind: 'rejected', reason: 'session' });
    expect(await later.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it.each([
    { label: 'an unknown physical action', kind: 'delete', overrides: {} },
    { label: 'an extra caller-selected path', kind: 'observe', overrides: { path: 'attachment.txt' } },
  ])('rejects $label without acting on the fixed attachment', async ({ kind, overrides }) => {
    const held = await broker();
    const refused = await held.request(kind, overrides);
    expect(refused.reply).toMatchObject({ kind: 'rejected', reason: 'protocol' });
    expect(await held.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('rejects a frame above the fixed byte limit rather than reading an unbounded command', async () => {
    const held = await broker();
    expect(await held.frame('x'.repeat(4097) + '\n')).toMatchObject({ kind: 'rejected', reason: 'protocol' });
    expect(await held.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('rejects a string protocol version rather than coercing it to the numeric version', async () => {
    const held = await broker();
    const refused = await held.request('observe', { version: '1' });
    expect(refused.reply).toMatchObject({ kind: 'rejected', reason: 'protocol' });
    expect(await held.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('refuses a different challenge on the same actual peer connection', async () => {
    const held = await broker();
    const refused = await held.request('observe', { challenge: randomUUID() });
    expect(refused.reply).toMatchObject({ kind: 'rejected', reason: 'session' });
    expect(await held.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('rejects duplicate JSON fields instead of accepting a last-value override', async () => {
    const held = await broker();
    const message = JSON.stringify({
      version: 1,
      kind: 'observe',
      requestId: randomUUID(),
      challenge: held.hello.challenge,
      sessionId: held.ready.sessionId,
    });
    const duplicate = message.replace('"requestId":', '"requestId":"' + randomUUID() + '","requestId":');
    expect(await held.frame(duplicate + '\n')).toMatchObject({ kind: 'rejected', reason: 'protocol' });
    expect(await held.finished()).toBe(0);
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('ends an incomplete frame at the actual read deadline without any action', async () => {
    const held = await broker();
    expect(await held.frame('{"version":1')).toMatchObject({ kind: 'rejected', reason: 'protocol' });
    expect(await held.finished()).toBe(0);
    const writer = await fs.open(file, 'r+');
    await writer.close();
    expect(await fs.readFile(file)).toEqual(bytes);
  }, 30000);

  it('closes native handles and root ownership after control EOF without resuming a new connection', async () => {
    const held = await broker();
    expect(held.ready.kind).toBe('held');
    await held.disconnect();
    const writer = await fs.open(file, 'r+');
    await writer.close();
    const later = await broker();
    expect(later.ready.kind).toBe('held');
    await later.release();
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('refuses a reparse intermediate directory before issuing any bound observation', async () => {
    const expected = await capture();
    const retained = path.join(root, 'retained');
    await fs.rename(parent, retained);
    await fs.symlink(retained, parent, 'junction');
    const refused = await broker(Promise.resolve(expected));
    expect(refused.ready).toMatchObject({ kind: 'rejected', reason: 'identity' });
    expect(await refused.finished()).toBe(0);
    expect(await fs.readFile(path.join(retained, 'attachment.txt'))).toEqual(bytes);
  });
});
