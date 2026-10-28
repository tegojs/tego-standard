import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';

import type { StagedAttachmentObjectIdentity, StagedAttachmentStorageValues } from './staged-upload';

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw new TypeError('Local recovery requires an exact JSON receipt');
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new TypeError('Local recovery receipt contains unavailable or unsafe fields');
      return [key, descriptor.value];
    }),
  );
}

function identity(value: unknown): StagedAttachmentObjectIdentity {
  const fields = record(value, ['dev', 'ino', 'birthtimeNs']);
  if (
    Object.values(fields).some((part) => typeof part !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(part)) ||
    fields.ino === '0' ||
    fields.birthtimeNs === '0'
  )
    throw new TypeError('Local recovery receipt has an invalid object identity');
  return fields as unknown as StagedAttachmentObjectIdentity;
}

function matches(stat: BigIntStats, expected: StagedAttachmentObjectIdentity) {
  return (
    String(stat.dev) === expected.dev &&
    String(stat.ino) === expected.ino &&
    String(stat.birthtimeNs) === expected.birthtimeNs
  );
}

const unsafeSegment = (segment: string) =>
  !segment ||
  segment === '.' ||
  segment === '..' ||
  /[<>:"\\|?*]|[. ]$/.test(segment) ||
  [...segment].some((character) => character.charCodeAt(0) < 32);

/** Synchronously detach the exact JSON evidence before any filesystem or persistence await. */
export function captureLocalStagedAttachment(
  expected: {
    readonly root: string;
    readonly values: Pick<StagedAttachmentStorageValues, 'path' | 'filename' | 'storageId' | 'size'>;
  },
  receipt: unknown,
) {
  const location = {
    root: expected.root,
    path: expected.values.path,
    filename: expected.values.filename,
    storageId: expected.values.storageId,
    size: expected.values.size,
  };
  if (
    typeof location.root !== 'string' ||
    !path.isAbsolute(location.root) ||
    typeof location.path !== 'string' ||
    (location.path !== '' && location.path.split('/').some(unsafeSegment)) ||
    typeof location.filename !== 'string' ||
    unsafeSegment(location.filename) ||
    location.filename.includes('/') ||
    !Number.isSafeInteger(location.size) ||
    location.size < 0 ||
    !['string', 'number'].includes(typeof location.storageId) ||
    String(location.storageId) === ''
  )
    throw new TypeError('Local recovery requires a trusted operation location');

  const captured = record(receipt, [
    'version',
    'kind',
    'root',
    'path',
    'filename',
    'storageId',
    'size',
    'directories',
    'object',
  ]);
  if (
    captured.version !== 1 ||
    captured.kind !== 'local' ||
    typeof captured.root !== 'string' ||
    captured.path !== location.path ||
    captured.filename !== location.filename ||
    captured.storageId !== location.storageId ||
    captured.size !== location.size
  )
    throw new TypeError('Local recovery receipt does not match the operation');
  const segments = location.path ? location.path.split('/') : [];
  const directoryPaths = ['', ...segments.map((_segment, index) => segments.slice(0, index + 1).join('/'))];
  const directories = captured.directories;
  if (
    !Array.isArray(directories) ||
    Object.getPrototypeOf(directories) !== Array.prototype ||
    directories.length !== directoryPaths.length ||
    Reflect.ownKeys(directories).length !== directories.length + 1
  )
    throw new TypeError('Local recovery receipt directory chain is invalid');
  const capturedDirectories = directoryPaths.map((relative, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(directories, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('Local recovery receipt directory is unavailable');
    const directory = record(descriptor.value, ['path', 'dev', 'ino', 'birthtimeNs']);
    if (directory.path !== relative) throw new TypeError('Local recovery receipt directory chain changed');
    return Object.freeze({
      path: relative,
      ...identity({ dev: directory.dev, ino: directory.ino, birthtimeNs: directory.birthtimeNs }),
    });
  });
  const object = identity(captured.object);
  return Object.freeze({
    location: Object.freeze(location),
    receipt: Object.freeze({
      version: 1 as const,
      kind: 'local' as const,
      root: captured.root,
      path: location.path,
      filename: location.filename,
      storageId: location.storageId,
      size: location.size,
      directories: Object.freeze(capturedDirectories),
      object: Object.freeze(object),
    }),
  });
}

/**
 * Read-only evidence check against an independently trusted operation location, never a request.
 * Requires stable server-owned directories. Does not authorize access/deletion, decide transaction
 * outcome, or lock the filesystem against replacement after checking.
 */
export async function verifyLocalStagedAttachment(
  expected: {
    readonly root: string;
    readonly values: Pick<StagedAttachmentStorageValues, 'path' | 'filename' | 'storageId' | 'size'>;
  },
  receipt: unknown,
): Promise<{ readonly state: 'present'; readonly size: number } | { readonly state: 'missing' }> {
  const { location, receipt: captured } = captureLocalStagedAttachment(expected, receipt);
  const directoryPaths = captured.directories.map((directory) => directory.path);
  let root: string;
  try {
    root = await fs.realpath(location.root);
    if (root !== captured.root) throw new TypeError('Local recovery storage root changed');
    for (let index = 0; index < directoryPaths.length; index++) {
      const directory = await fs.lstat(path.join(root, directoryPaths[index]), { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink() || !matches(directory, captured.directories[index]))
        throw new TypeError('Local recovery storage directory was replaced');
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new TypeError('Local recovery storage directory is unavailable');
    throw error;
  }
  let objectStat: BigIntStats;
  try {
    objectStat = await fs.lstat(path.join(root, location.path, location.filename), { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ state: 'missing' });
    throw error;
  }
  if (
    !objectStat.isFile() ||
    !matches(objectStat, captured.object) ||
    objectStat.size < 0n ||
    objectStat.size > BigInt(location.size)
  )
    throw new TypeError('Local recovery object was replaced or changed');
  return Object.freeze({ state: 'present', size: Number(objectStat.size) });
}
