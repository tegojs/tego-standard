import { randomBytes } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { StagedAttachmentUpload } from '../actions/staged-upload';
import { getLocalStorageRoot } from './local-root';
import type { StagedAttachmentStorage, StagedAttachmentStoragePlan } from './staged-upload';

const invalidSegment = (segment: string) =>
  !segment ||
  segment === '.' ||
  segment === '..' ||
  /[<>:"\\|?*]|[. ]$/.test(segment) ||
  [...segment].some((character) => character.charCodeAt(0) < 32);

/** Server-owned directories only; filesystem writers must not rename/replace paths during a plan.
 * Database commit, G and durable compensation remain the caller's responsibility.
 */
export function prepareLocalStagedUpload(
  storage: StagedAttachmentStorage,
  file: StagedAttachmentUpload,
): StagedAttachmentStoragePlan {
  if (
    typeof storage.path !== 'string' ||
    path.posix.isAbsolute(storage.path) ||
    path.win32.isAbsolute(storage.path) ||
    (storage.path !== '' && storage.path.split('/').some(invalidSegment)) ||
    !['string', 'number'].includes(typeof storage.id) ||
    String(storage.id) === '' ||
    typeof file.path !== 'string' ||
    !path.isAbsolute(file.path) ||
    typeof file.originalname !== 'string' ||
    !file.originalname ||
    typeof file.mimetype !== 'string' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0
  )
    throw new TypeError('Planned local upload requires a server storage and staged file');
  const extname = path.extname(file.originalname);
  if (extname && (extname.length > 64 || invalidSegment(extname)))
    throw new TypeError('Attachment extension is not a safe local filename');
  const root = getLocalStorageRoot(storage);
  const filename = `${randomBytes(16).toString('hex')}${extname}`;
  const values = Object.freeze({
    title: path.basename(file.originalname, extname),
    filename,
    extname,
    mimetype: file.mimetype,
    size: file.size,
    path: storage.path,
    url: `${storage.baseUrl.replace(/\/+$/, '')}/${storage.path ? `${storage.path}/` : ''}${filename}`,
    storageId: storage.id,
    meta: Object.freeze({}),
  });
  let destination: string;
  let owned = false;
  let object: Pick<BigIntStats, 'dev' | 'ino'> | undefined;
  let started = false;
  let discarded = false;
  let writing: Promise<void> | undefined;
  let discarding: Promise<void> | undefined;

  const remove = async () => {
    if (!owned) return;
    if (!object) throw new TypeError('Attachment object identity is unavailable; cleanup remains pending');
    try {
      const current = await fs.lstat(destination, { bigint: true });
      if (!current.isFile() || current.dev !== object.dev || current.ino !== object.ino)
        throw new TypeError('Planned attachment object was replaced; refusing to remove it');
      await fs.unlink(destination);
      owned = false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      owned = false;
    }
  };
  const write = async () => {
    let input: FileHandle | undefined;
    let output: FileHandle | undefined;
    try {
      // Open and validate the source before creating anything in the final storage.
      input = await fs.open(file.path, 'r');
      const source = await input.stat();
      if (!source.isFile() || source.size !== values.size)
        throw new TypeError('Staged attachment is unavailable or changed');
      await fs.mkdir(root, { recursive: true });
      let parent = await fs.realpath(root);
      for (const segment of values.path ? values.path.split('/') : []) {
        parent = path.join(parent, segment);
        try {
          await fs.mkdir(parent);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const directory = await fs.lstat(parent);
        if (!directory.isDirectory() || directory.isSymbolicLink())
          throw new TypeError('Attachment storage path must not traverse symbolic links');
      }
      destination = path.join(parent, filename);
      output = await fs.open(destination, 'wx', 0o600);
      owned = true;
      object = await output.stat({ bigint: true });
      await pipeline(input.createReadStream(), output.createWriteStream());
      const actual = await fs.lstat(destination, { bigint: true });
      if (
        !actual.isFile() ||
        actual.dev !== object.dev ||
        actual.ino !== object.ino ||
        actual.size !== BigInt(values.size)
      )
        throw new TypeError('Stored attachment does not match the newly created object');
    } finally {
      await output?.close();
      await input?.close();
    }
  };
  const start = (cleanupOnFailure: boolean) => {
    if (started || discarded) return Promise.reject(new TypeError('Attachment storage plan has already been used'));
    started = true;
    writing = write();
    if (cleanupOnFailure)
      writing = writing.catch(async (error) => {
        try {
          await remove();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Attachment storage failed and cleanup remains pending');
        }
        throw error;
      });
    return writing;
  };
  return Object.freeze({
    values,
    store() {
      return start(true);
    },
    storeForTransaction() {
      return start(false);
    },
    discard() {
      discarded = true;
      if (!discarding)
        discarding = (async () => {
          await writing?.catch(() => {});
          await remove();
        })().finally(() => {
          discarding = undefined;
        });
      return discarding;
    },
  });
}
