import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Test-only kernel admission candidate. No attachment-removal executor or production helper.
describe.skipIf(process.platform !== 'win32')('broker-owned fixture admission boundaries', () => {
  let directory: string;
  let root: string;
  let original: string;
  let destination: string;
  const bytes = Buffer.from('New admission fixture attachment, always retained');
  const children = new Set<{ child: ReturnType<typeof spawn>; closed: Promise<number | null> }>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-admission-'));
    root = path.join(directory, 'root');
    await fs.mkdir(root);
    await fs.mkdir(path.join(directory, 'control'));
    original = path.join(root, 'attachment.txt');
    destination = path.join(root, 'new-write.txt');
    await fs.writeFile(original, bytes, { flag: 'wx' });
  });

  afterEach(async () => {
    // Release only this fresh fixture's test gate if an assertion failed after controller death.
    await fs.writeFile(path.join(directory, 'control', 'allow'), 'fixture cleanup releases the test gate');
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    children.clear();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  async function broker(fixtureDirectory = directory, withController = false) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-admission.ps1', import.meta.url));
    // Inherited output lets the test observe the actual broker after this controller is terminated.
    const controller = String.raw`
      const { spawn } = require('node:child_process');
      const broker = spawn('pwsh.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', process.env.TEGO_ADMISSION_FIXTURE_SCRIPT
      ], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
      process.stdout.write('broker:' + broker.pid + '\n');
      process.stdin.pipe(broker.stdin);
      broker.stdin.on('error', error => process.stderr.write(String(error)));
      broker.once('error', error => { process.stderr.write(String(error)); process.exit(1); });
      broker.once('close', code => process.exit(code === null ? 1 : code));
    `;
    const child = spawn(
      withController ? process.execPath : 'pwsh.exe',
      withController ? ['-e', controller] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TEGO_ADMISSION_FIXTURE_DIRECTORY: fixtureDirectory,
          TEGO_ADMISSION_FIXTURE_SCRIPT: fixture,
        },
      },
    );
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (value: string) => {
      diagnostics += value;
    });
    child.stdin.on('error', (error) => {
      diagnostics += String(error);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    void closed.catch(() => {});
    children.add({ child, closed });
    const next = async () => {
      const result = await lines.next();
      return result.done ? 'closed' : result.value;
    };
    let brokerPid = child.pid;
    if (withController) {
      const announcement = await next();
      if (!/^broker:[0-9]+$/.test(announcement)) throw new Error('Missing actual broker pid: ' + announcement);
      brokerPid = Number(announcement.slice('broker:'.length));
    }
    const ready = await next();
    if (withController && ready === 'closed') {
      const code = await closed;
      throw new Error('Controlled broker failed to start (exit ' + code + '): ' + diagnostics);
    }
    return {
      ready,
      next,
      alive() {
        try {
          process.kill(brokerPid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      },
      async command(value: string) {
        child.stdin.write(value + '\n');
        return next();
      },
      endInput() {
        child.stdin.end();
      },
      async release() {
        if (child.exitCode === null && child.signalCode === null && !child.stdin.writableEnded) {
          child.stdin.end('release\n');
        }
        const code = await closed;
        if (code !== 0) throw new Error('Admission fixture failed: ' + diagnostics);
      },
      async terminate() {
        child.kill();
        await closed;
      },
      async terminateController() {
        if (!withController) throw new Error('This fixture has no separate controller');
        child.kill();
        await exited;
      },
      finished: () => closed,
    };
  }

  it('blocks a participating writer before any new file and allows one write only after normal release', async () => {
    const owner = await broker();
    const writer = await broker();
    expect(owner.ready).toBe('held');
    expect(writer.ready).toBe('busy');
    expect(await writer.command('write')).toBe('rejected:admission');
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await owner.release();
    expect(await writer.command('take')).toBe('held');
    expect(await writer.command('write')).toBe('written');
    expect(await fs.readFile(destination, 'utf8')).toBe('New admitted fixture write');
    expect(await writer.command('write')).toBe('rejected:consumed');
    await writer.release();
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('refuses action after a real owning process dies and a live contender receives abandonment', async () => {
    const owner = await broker();
    const writer = await broker();
    expect(owner.ready).toBe('held');
    expect(writer.ready).toBe('busy');
    await owner.terminate();
    expect(await writer.command('take')).toBe('abandoned');
    expect(await writer.command('write')).toBe('rejected:admission');
    await writer.release();
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('has no durable death memory when the sole owner and all named-object handles disappear', async () => {
    const owner = await broker();
    expect(owner.ready).toBe('held');
    await owner.terminate();
    const later = await broker();
    expect(later.ready).toBe('held');
    await later.release();
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('keeps admission through an accepted queued write even after the control input reaches EOF', async () => {
    const owner = await broker();
    expect(owner.ready).toBe('held');
    expect(await owner.command('queue-write')).toBe('queued');
    owner.endInput();
    const writer = await broker();
    expect(writer.ready).toBe('busy');
    expect(await writer.command('write')).toBe('rejected:admission');
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(directory, 'control', 'allow'), 'test releases the queued command', { flag: 'wx' });
    expect(await owner.next()).toBe('written');
    expect(await owner.finished()).toBe(0);
    expect(await fs.readFile(destination, 'utf8')).toBe('New admitted fixture write');
    expect(await writer.command('take')).toBe('held');
    await writer.release();
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('performs no queued action when the command input closes before any command', async () => {
    const owner = await broker();
    expect(owner.ready).toBe('held');
    owner.endInput();
    expect(await owner.finished()).toBe(0);
    const later = await broker();
    expect(later.ready).toBe('held');
    await later.release();
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('loses an attached broker and its queued command when the actual controller process dies', async () => {
    const owner = await broker(directory, true);
    expect(owner.ready).toBe('held');
    expect(await owner.command('queue-write')).toBe('queued');
    expect(owner.alive()).toBe(true);
    const writer = await broker();
    expect(writer.ready).toBe('busy');
    await owner.terminateController();
    expect(await owner.next()).toBe('closed');
    await owner.finished();
    expect(owner.alive()).toBe(false);
    expect(await writer.command('take')).toBe('abandoned');
    expect(await writer.command('write')).toBe('rejected:admission');
    await writer.release();
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('does not block a real filesystem writer that never participates in the protocol', async () => {
    const owner = await broker();
    expect(owner.ready).toBe('held');
    const unrelated = path.join(root, 'unadmitted-write.txt');
    await fs.writeFile(unrelated, 'A new fixture written outside admission', { flag: 'wx' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('A new fixture written outside admission');
    await owner.release();
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it('rejects a nested or arbitrary fixture namespace before any root write', async () => {
    const refused = await broker(root);
    expect(refused.ready).toBe('closed');
    expect(await refused.finished()).not.toBe(0);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(original)).toEqual(bytes);
  });
});
