import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Test-only transport for the fixed, read-only new-fixture broker. Never a cleanup capability.
export async function openReadOnlyRemovalFixtureSession(directory: string) {
  if (
    path.dirname(directory).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() ||
    !/^tego-removal-session-[a-zA-Z0-9]+$/.test(path.basename(directory))
  )
    throw new Error('Only a direct new session fixture is accepted');
  const root = path.join(directory, 'root');
  const parent = path.join(root, 'nested');
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
      directory: stat.isDirectory(),
      reparse: stat.isSymbolicLink(),
    };
  };
  const expected = {
    file: await identity(path.join(parent, 'attachment.txt')),
    directories: await Promise.all([directory, root, parent].map(identity)),
  };
  const pipeName = 'tego-removal-session-' + randomUUID();
  const child = spawn(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./removal-session.ps1', import.meta.url)),
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        TEGO_SESSION_FIXTURE_DIRECTORY: directory,
        TEGO_SESSION_FIXTURE_PIPE: pipeName,
        TEGO_SESSION_FIXTURE_EXPECTED: JSON.stringify(expected),
      },
    },
  );
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value: string) => {
    diagnostics += value;
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  void closed.catch(() => {});
  let socket: net.Socket | undefined;
  let reader: ReturnType<typeof createInterface> | undefined;
  let ended = false;
  const dispose = async () => {
    ended = true;
    socket?.destroy();
    reader?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        socket = await new Promise<net.Socket>((resolve, reject) => {
          const candidate = net.createConnection('\\\\.\\pipe\\' + pipeName);
          candidate.once('error', (error) => {
            candidate.destroy();
            reject(error);
          });
          candidate.once('connect', () => resolve(candidate));
        });
        break;
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
          throw new Error('Fixture startup failed: ' + String(error) + diagnostics);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await delay(25);
      }
    }
    socket.on('error', (error) => {
      diagnostics += String(error);
    });
    reader = createInterface({ input: socket, crlfDelay: Infinity });
    const lines = reader[Symbol.asyncIterator]();
    const challenge = randomUUID();
    let sessionId: string | undefined;
    const exchange = async (kind: 'hello' | 'observe' | 'close') => {
      if (ended || child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture session ended');
      const requestId = randomUUID();
      socket!.write(
        JSON.stringify({ version: 1, kind, requestId, challenge, ...(sessionId ? { sessionId } : {}) }) + '\n',
      );
      const line = await lines.next();
      if (line.done) throw new Error('Fixture session ended: ' + diagnostics);
      const reply = JSON.parse(line.value);
      if (reply.kind === 'rejected') throw new Error('Fixture rejected: ' + reply.reason);
      if (
        reply.version !== 1 ||
        reply.requestId !== requestId ||
        reply.challenge !== challenge ||
        (sessionId && reply.sessionId !== sessionId) ||
        reply.kind !== (kind === 'hello' ? 'held' : kind === 'close' ? 'closed' : 'observed')
      )
        throw new Error('Fixture reply correlation failed');
      if (kind !== 'close' && (reply.peerProcessId !== process.pid || reply.brokerProcessId !== child.pid))
        throw new Error('Fixture peer correlation failed');
      return reply as { sessionId: string; observations: typeof expected };
    };
    const ready = await exchange('hello');
    sessionId = ready.sessionId;
    return {
      initial: ready.observations,
      async observe() {
        return (await exchange('observe')).observations;
      },
      async close() {
        try {
          await exchange('close');
          ended = true;
          await closed;
          if (child.exitCode !== 0) throw new Error('Fixture close failed: ' + diagnostics);
        } finally {
          await dispose();
        }
      },
      terminate: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
