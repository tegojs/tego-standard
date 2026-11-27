import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PermissionObservation {
  restrictedThreadVerified: boolean;
  originalThreadRestored: boolean;
  newAttributeOpenError: number;
  oldAttributeWrite?: boolean;
  insideLinkError?: number;
  outsideLinkError?: number;
  newDataOpenError?: number;
  shareGateOpenError?: number;
  shareGateAfterUnmapOpenError?: number;
  mappedDev?: string;
  mappedIno?: string;
}

// New fixture DACL/token dependency characterization, never a production executor.
describe.skipIf(process.platform !== 'win32')('Windows fixture permission boundaries', () => {
  let directory: string;
  const bytes = Buffer.from('Fresh permission fixture bytes; never a business attachment\n');
  const changedTime = new Date('2000-01-02T03:04:05.000Z');
  const children = new Set<{ child: ReturnType<typeof spawn>; closed: Promise<number | null> }>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-permissions-'));
  });

  afterEach(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    children.clear();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  async function probe(mode: string, candidate = directory) {
    const fixture = fileURLToPath(new URL('./fixtures/removal-permissions.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEGO_PERMISSION_DIRECTORY: candidate, TEGO_PERMISSION_CASE: mode },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value: string) => (stdout += value));
    child.stderr.setEncoding('utf8').on('data', (value: string) => (stderr += value));
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    children.add({ child, closed });
    const code = await closed;
    return { code, stdout: stdout.trim(), stderr };
  }

  async function observe(mode: string, expectedBytes = bytes): Promise<PermissionObservation> {
    const result = await probe(mode);
    expect(result, 'actual helper exit and diagnostics').toMatchObject({ code: 0, stderr: '' });
    const observation = JSON.parse(result.stdout) as PermissionObservation;
    expect(observation).toMatchObject({ restrictedThreadVerified: true, originalThreadRestored: true });
    expect(await fs.readFile(path.join(directory, 'data', 'probe.txt'))).toEqual(expectedBytes);
    return observation;
  }

  it('positively opens attributes and creates an alias with the actual restricted thread', async () => {
    const result = await observe('granted');
    expect(result).toMatchObject({ newAttributeOpenError: 0, insideLinkError: 0 });
    const file = await fs.stat(path.join(directory, 'data', 'probe.txt'), { bigint: true });
    const alias = await fs.stat(path.join(directory, 'data', 'inside-link.txt'), { bigint: true });
    expect([alias.dev, alias.ino, file.nlink, alias.nlink]).toEqual([file.dev, file.ino, 2n, 2n]);
    expect(await fs.readFile(path.join(directory, 'data', 'inside-link.txt'))).toEqual(bytes);
  });

  it('rejects a new attribute-write handle after removing the restricting SID grant', async () => {
    const result = await observe('new-attributes-denied');
    expect(result.newAttributeOpenError).toBe(5);
    expect((await fs.stat(path.join(directory, 'data', 'probe.txt'))).mtimeMs).not.toBe(changedTime.getTime());
    // Actual original-identity reopening after restoration, not an ACL-text comparison.
    await fs.utimes(path.join(directory, 'data', 'probe.txt'), changedTime, changedTime);
    expect((await fs.stat(path.join(directory, 'data', 'probe.txt'))).mtimeMs).toBe(changedTime.getTime());
  });

  it('retains an already granted attribute handle across DACL tightening', async () => {
    const result = await observe('old-attributes');
    expect(result).toMatchObject({ newAttributeOpenError: 5, oldAttributeWrite: true });
    expect((await fs.stat(path.join(directory, 'data', 'probe.txt'))).mtimeMs).toBe(changedTime.getTime());
  });

  it('blocks an inside new name but permits an alias in another writable fixture directory', async () => {
    const result = await observe('outside-alias');
    expect(result).toMatchObject({ insideLinkError: 5, outsideLinkError: 0 });
    await expect(fs.stat(path.join(directory, 'data', 'inside-link.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const file = await fs.stat(path.join(directory, 'data', 'probe.txt'), { bigint: true });
    const alias = await fs.stat(path.join(directory, 'outside', 'outside-link.txt'), { bigint: true });
    expect([alias.dev, alias.ino, file.nlink, alias.nlink]).toEqual([file.dev, file.ino, 2n, 2n]);
    expect(await fs.readFile(path.join(directory, 'outside', 'outside-link.txt'))).toEqual(bytes);
  });

  it('retains an old writable view after closing source handles and tightening its DACL', async () => {
    const changed = Buffer.from('Mresh permission fixture bytes; never a business attachment\n');
    const result = await observe('old-writable-view', changed);
    expect(result.newDataOpenError).toBe(5);
    const stat = await fs.stat(path.join(directory, 'data', 'probe.txt'), { bigint: true });
    expect([String(stat.dev), String(stat.ino), stat.nlink, stat.size]).toEqual([
      result.mappedDev,
      result.mappedIno,
      1n,
      BigInt(changed.length),
    ]);
  });

  it('rejects share-denying admission until the old writable view is unmapped', async () => {
    const changed = Buffer.from('Mresh permission fixture bytes; never a business attachment\n');
    const result = await observe('mapped-share-gate', changed);
    expect(result).toMatchObject({ newDataOpenError: 5, shareGateOpenError: 32, shareGateAfterUnmapOpenError: 0 });
    const stat = await fs.stat(path.join(directory, 'data', 'probe.txt'), { bigint: true });
    expect([String(stat.dev), String(stat.ino), stat.nlink, stat.size]).toEqual([
      result.mappedDev,
      result.mappedIno,
      1n,
      BigInt(changed.length),
    ]);
  });

  it('rejects a populated namespace without opening or changing its existing bytes', async () => {
    const sentinel = path.join(directory, 'sentinel.txt');
    await fs.writeFile(sentinel, bytes, { flag: 'wx' });
    const result = await probe('granted');
    expect(result).toMatchObject({ code: 2, stdout: 'rejected:fixture-boundary', stderr: '' });
    expect(await fs.readdir(directory)).toEqual(['sentinel.txt']);
    expect(await fs.readFile(sentinel)).toEqual(bytes);
  });

  it('rejects nested namespaces before creating objects or changing permissions', async () => {
    const nested = path.join(directory, 'tego-removal-permissions-nested');
    await fs.mkdir(nested);
    const result = await probe('granted', nested);
    expect(result).toMatchObject({ code: 2, stdout: 'rejected:fixture-boundary', stderr: '' });
    expect(await fs.readdir(nested)).toEqual([]);
  });

  it('rejects an arbitrary direct temp directory name without creating objects', async () => {
    const renamed = path.join(os.tmpdir(), 'tego-permission-unrelated-' + path.basename(directory));
    await fs.rename(directory, renamed);
    directory = renamed;
    const result = await probe('granted');
    expect(result).toMatchObject({ code: 2, stdout: 'rejected:fixture-boundary', stderr: '' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('rejects an unknown operation before creating objects or changing permissions', async () => {
    const result = await probe('delete');
    expect(result).toMatchObject({ code: 2, stdout: 'rejected:fixture-boundary', stderr: '' });
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
