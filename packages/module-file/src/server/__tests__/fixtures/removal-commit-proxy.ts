import { once } from 'node:events';
import net from 'node:net';

type LossMode = 'before-forward' | 'after-complete';
interface Report {
  commitSeen: number;
  commitForwarded: number;
  completionReceived: number;
  completionDelivered: number;
  backendProcessId?: number;
}
interface Fault {
  mode: LossMode;
  report: Report;
  finish: (error?: Error) => void;
}

/** Test-only real TCP loss. Fixed local PG17 target and one dedicated database, never a general proxy. */
export async function createRemovalCommitProxy(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const database = target.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.hostname !== '127.0.0.1' ||
    target.port !== '25466' ||
    decodeURIComponent(target.username) !== 'tenant_test' ||
    !/^tego_tenant_access_test_[a-f0-9]{10}$/.test(database) ||
    target.search ||
    target.hash
  )
    throw new Error('Commit-loss fixtures require the fixed dedicated local test database');
  const sockets = new Set<net.Socket>();
  const closures: Promise<unknown>[] = [];
  let pending: Fault | undefined;
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    closures.push(
      new Promise<void>((resolve) =>
        socket.once('close', () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
    return socket;
  };
  const frames = (startup: boolean, receive: (frame: Buffer, first: boolean) => boolean) => {
    let buffered = Buffer.alloc(0);
    return (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < (startup ? 4 : 5)) return;
        const length = startup ? buffered.readUInt32BE(0) : buffered.readUInt32BE(1) + 1;
        if (length < (startup ? 8 : 5) || length > 1024 * 1024) throw new Error('Invalid fixture PG frame');
        if (buffered.length < length) return;
        const frame = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        const first = startup;
        startup = false;
        if (!receive(frame, first)) return;
      }
    };
  };
  const server = net.createServer((client) => {
    track(client);
    let backend: net.Socket | undefined;
    let selected: Fault | undefined;
    let backendProcessId: number | undefined;
    const closePair = () => {
      client.destroy();
      backend?.destroy();
    };
    client.on('error', closePair);
    client.on('close', () => backend?.destroy());
    const serverFrames = frames(false, (frame) => {
      if (frame[0] === 75 && frame.length === 13) backendProcessId = frame.readInt32BE(5);
      const complete = frame[0] === 67 && frame.toString('utf8', 5) === 'COMMIT\0';
      if (complete && selected) {
        selected.report.completionReceived++;
        if (selected.mode === 'after-complete') {
          closePair();
          selected.finish();
          return false;
        }
        selected.report.completionDelivered++;
      }
      client.write(frame);
      return true;
    });
    const clientFrames = frames(true, (frame, first) => {
      if (first) {
        if (frame.readUInt32BE(4) !== 196608) throw new Error('Only cleartext fixture PG v3 startup is accepted');
        const body = frame.toString('utf8', 8);
        if (!body.endsWith('\0\0')) throw new Error('Invalid fixture startup');
        const fields = body.slice(0, -2).split('\0');
        if (fields.length % 2 !== 0) throw new Error('Invalid fixture startup');
        const parameters = new Map<string, string>();
        for (let index = 0; index < fields.length; index += 2) {
          if (parameters.has(fields[index])) throw new Error('Duplicate fixture startup field');
          parameters.set(fields[index], fields[index + 1]);
        }
        if (parameters.get('database') !== database || parameters.get('user') !== 'tenant_test')
          throw new Error('Unexpected fixture database or role');
        backend = track(net.createConnection({ host: '127.0.0.1', port: 25466 }));
        backend.on('error', closePair);
        backend.on('close', () => client.destroy());
        backend.on('data', (chunk) => {
          try {
            serverFrames(chunk);
          } catch {
            closePair();
          }
        });
        backend.write(frame);
        return true;
      }
      const commit = frame[0] === 81 && /^COMMIT;?$/i.test(frame.toString('utf8', 5, frame.length - 1).trim());
      if (commit && pending) {
        selected = pending;
        pending = undefined;
        selected.report.commitSeen++;
        selected.report.backendProcessId = backendProcessId;
        if (selected.mode === 'before-forward') {
          closePair();
          selected.finish();
          return false;
        }
        selected.report.commitForwarded++;
      }
      backend!.write(frame);
      return true;
    });
    client.on('data', (chunk) => {
      try {
        clientFrames(chunk);
      } catch {
        closePair();
      }
    });
  });
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture TCP listener unavailable');
  const connection = new URL(target);
  connection.port = String(address.port);
  return {
    url: connection.toString(),
    arm(mode: LossMode) {
      if (pending) throw new Error('A fixture fault is already armed');
      const report: Report = { commitSeen: 0, commitForwarded: 0, completionReceived: 0, completionDelivered: 0 };
      let finish: Fault['finish'];
      const observed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No actual COMMIT loss observed')), 15000);
        timer.unref();
        finish = (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
      });
      void observed.catch(() => {});
      pending = { mode, report, finish: finish! };
      return { observed, snapshot: () => Object.freeze({ ...report }) };
    },
    async close() {
      pending?.finish(new Error('Fixture closed before its fault'));
      pending = undefined;
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
      await Promise.all(closures);
    },
  };
}
