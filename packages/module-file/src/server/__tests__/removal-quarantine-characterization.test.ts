import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dependency characterization only. No quarantine implementation, removal permission or unlink.
describe('local removal quarantine candidate boundaries', () => {
  let directory: string;
  let source: string;
  let destination: string;
  const original = Buffer.from('Original attachment bytes remain retained');
  const replacement = Buffer.from('A different attachment remains retained');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-quarantine-'));
    source = path.join(directory, 'storage', 'attachment.txt');
    await fs.mkdir(path.dirname(source));
    const privateDirectory = await fs.mkdtemp(path.join(directory, 'private-'));
    destination = path.join(privateDirectory, 'attachment.txt');
    await fs.writeFile(source, original, { flag: 'wx' });
  });

  afterEach(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  const identity = async (file: string) => {
    const value = await fs.stat(file, { bigint: true });
    return { dev: String(value.dev), ino: String(value.ino), birthtimeNs: String(value.birthtimeNs) };
  };

  async function child(script: string) {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, source, destination], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (data: string) => {
      stderr += data;
    });
    process.stdout.resume();
    await new Promise<void>((resolve, reject) => {
      process.once('error', reject);
      process.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Quarantine fixture child exited ${code}: ${stderr}`));
      });
    });
  }

  it('moves the same physical object while a normal Node read handle remains open', async () => {
    const before = await identity(source);
    const handle = await fs.open(source, 'r');
    try {
      await child(`
        import { rename } from 'node:fs/promises';
        await rename(process.argv[1], process.argv[2]);
      `);
      expect(await identity(destination)).toEqual(before);
      expect(await handle.readFile()).toEqual(original);
      expect(await fs.readFile(destination)).toEqual(original);
      await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await handle.close();
    }
  });

  it('allows another process to reuse the original path without changing the moved object', async () => {
    const before = await identity(source);
    await fs.rename(source, destination);
    await child(`
      import { writeFile } from 'node:fs/promises';
      await writeFile(process.argv[1], 'A different attachment remains retained', { flag: 'wx' });
    `);
    expect(await identity(destination)).toEqual(before);
    expect(await identity(source)).not.toEqual(before);
    expect(await fs.readFile(destination)).toEqual(original);
    expect(await fs.readFile(source)).toEqual(replacement);
  });

  it('can move a substituted source, so a successful rename alone cannot certify captured identity', async () => {
    const before = await identity(source);
    const retained = path.join(directory, 'retained-original.txt');
    await fs.rename(source, retained);
    await child(`
      import { writeFile, rename } from 'node:fs/promises';
      await writeFile(process.argv[1], 'A different attachment remains retained', { flag: 'wx' });
      await rename(process.argv[1], process.argv[2]);
    `);
    expect(await identity(destination)).not.toEqual(before);
    expect(await fs.readFile(destination)).toEqual(replacement);
    expect(await identity(retained)).toEqual(before);
    expect(await fs.readFile(retained)).toEqual(original);
  });

  it('does not exclude a pre-existing writer handle after transfer into a fresh private directory', async () => {
    const writer = await fs.open(source, 'r+');
    const before = await identity(source);
    try {
      await child(`
        import { rename } from 'node:fs/promises';
        await rename(process.argv[1], process.argv[2]);
      `);
      // The namespace move has already completed in a distinct process. No timing sleep is used.
      await writer.write(Buffer.from('CHANGED'), 0, 7, 0);
      await writer.sync();
      expect(await identity(destination)).toEqual(before);
      expect((await fs.readFile(destination)).subarray(0, 7).toString()).toBe('CHANGED');
      await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await writer.close();
    }
  });

  it('allows a pre-existing writer to change the object after a successful full metadata observation', async () => {
    const writer = await fs.open(source, 'r+');
    try {
      await fs.rename(source, destination);
      const observed = await fs.stat(destination, { bigint: true });
      expect(await fs.readFile(destination)).toEqual(original);
      await writer.truncate(original.length + 10);
      await writer.sync();
      const after = await fs.stat(destination, { bigint: true });
      expect(after.dev).toBe(observed.dev);
      expect(after.ino).toBe(observed.ino);
      expect(after.birthtimeNs).toBe(observed.birthtimeNs);
      expect(after.size).toBe(BigInt(original.length + 10));
      expect((await fs.readFile(destination)).subarray(0, original.length)).toEqual(original);
    } finally {
      await writer.close();
    }
  });
});
