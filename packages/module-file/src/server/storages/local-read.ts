import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { getLocalStorageRoot } from './local-root';
import type { StagedAttachmentStorage } from './staged-upload';

export interface LocalAttachmentReadRecord {
  readonly path: string;
  readonly filename: string;
  readonly storageId: string | number;
  readonly size: number;
}

const unsafeSegment = (segment: string) =>
  !segment ||
  segment === '.' ||
  segment === '..' ||
  /[<>:"\\|?*]|[. ]$/.test(segment) ||
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
  [...segment].some((character) => character.charCodeAt(0) < 32);

function sameObject(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino > 0n &&
    left.ino === right.ino &&
    left.birthtimeNs > 0n &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function captureRecord(record: LocalAttachmentReadRecord): LocalAttachmentReadRecord {
  if (!record || ![Object.prototype, null].includes(Object.getPrototypeOf(record)))
    throw new TypeError('Local attachment reading requires raw stored values');
  return Object.fromEntries(
    ['path', 'filename', 'storageId', 'size'].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        throw new TypeError('Local attachment location must not contain accessors or missing values');
      return [key, descriptor.value];
    }),
  ) as unknown as LocalAttachmentReadRecord;
}

/** Only after independent record ACL and G/V authorization. No routes or public URL protection.
 * The server must exclusively own stable storage directories and stored bytes during this call.
 * Await all consumption inside the callback; the read-only handle is closed when it settles.
 */
export async function withLocalAttachmentRead<T>(
  storage: StagedAttachmentStorage,
  record: LocalAttachmentReadRecord,
  consume: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  const captured = captureRecord(record);
  const key = (value: unknown) =>
    (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value));
  if (
    storage?.type !== 'local' ||
    !key(storage.id) ||
    !key(captured.storageId) ||
    String(captured.storageId) !== String(storage.id) ||
    typeof captured.path !== 'string' ||
    (captured.path !== '' && captured.path.split('/').some(unsafeSegment)) ||
    typeof captured.filename !== 'string' ||
    captured.filename.includes('/') ||
    unsafeSegment(captured.filename) ||
    !Number.isSafeInteger(captured.size) ||
    captured.size < 0 ||
    typeof consume !== 'function'
  )
    throw new TypeError('Local attachment location or storage is invalid');
  const configuredRoot = getLocalStorageRoot(storage);
  const root = await fs.realpath(configuredRoot);
  const directories = [root];
  for (const segment of captured.path ? captured.path.split('/') : [])
    directories.push(path.join(directories[directories.length - 1], segment));
  const identities: BigIntStats[] = [];
  for (const directory of directories) {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameObject(stat, stat))
      throw new TypeError('Local attachment directory is unavailable or unsafe');
    identities.push(stat);
  }
  const filename = path.join(directories[directories.length - 1], captured.filename);
  const before = await fs.lstat(filename, { bigint: true });
  const validFile = (stat: BigIntStats) => stat.isFile() && stat.nlink === 1n && stat.size === BigInt(captured.size);
  if (!validFile(before) || !sameObject(before, before))
    throw new TypeError('Local attachment is not a matching regular file');
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await fs.lstat(filename, { bigint: true });
    if (
      !validFile(opened) ||
      !validFile(current) ||
      !sameObject(before, opened) ||
      !sameObject(opened, current) ||
      before.mtimeNs !== opened.mtimeNs ||
      before.ctimeNs !== opened.ctimeNs ||
      opened.mtimeNs !== current.mtimeNs ||
      opened.ctimeNs !== current.ctimeNs ||
      (await fs.realpath(configuredRoot)) !== root
    )
      throw new TypeError('Local attachment changed while opening');
    for (let index = 0; index < directories.length; index++) {
      const currentDirectory = await fs.lstat(directories[index], { bigint: true });
      if (!currentDirectory.isDirectory() || !sameObject(identities[index], currentDirectory))
        throw new TypeError('Local attachment directory changed while opening');
    }
    return await consume(handle);
  } finally {
    await handle.close();
  }
}
