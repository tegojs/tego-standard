import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isUnsafeLocalAttachmentSegment } from './local-read';
import type { LocalAttachmentRemovalObject } from './local-removal-object';

const invalid = (): never => {
  throw new TypeError('Removal object binding is invalid or inconsistent');
};
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const signed = (value: unknown): value is string => typeof value === 'string' && /^(0|-?[1-9]\d*)$/.test(value);
const key = (value: unknown): value is string | number =>
  (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value));

function identity(value: unknown) {
  if (
    !object(value) ||
    !decimal(value.dev) ||
    !decimal(value.ino) ||
    value.ino === '0' ||
    !decimal(value.birthtimeNs) ||
    value.birthtimeNs === '0'
  )
    return invalid();
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}

/** Pure format validation of persisted historical evidence. No file lookup, permission or lease. */
export function validateLocalAttachmentRemovalObject(value: unknown): LocalAttachmentRemovalObject {
  if (!object(value) || !object(value.record) || !object(value.object) || !Array.isArray(value.directories))
    return invalid();
  const { record } = value;
  if (
    typeof value.collectionName !== 'string' ||
    !value.collectionName ||
    typeof value.configuredRoot !== 'string' ||
    !path.isAbsolute(value.configuredRoot) ||
    path.normalize(value.configuredRoot) !== value.configuredRoot ||
    typeof value.root !== 'string' ||
    !path.isAbsolute(value.root) ||
    path.normalize(value.root) !== value.root ||
    !key(record.key) ||
    !key(record.storageId) ||
    typeof record.path !== 'string' ||
    (record.path !== '' && record.path.split('/').some(isUnsafeLocalAttachmentSegment)) ||
    typeof record.filename !== 'string' ||
    record.filename.includes('/') ||
    isUnsafeLocalAttachmentSegment(record.filename) ||
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    !signed(value.object.mtimeNs) ||
    !signed(value.object.ctimeNs) ||
    value.object.size !== String(record.size)
  )
    return invalid();
  const segments = record.path ? record.path.split('/') : [];
  const paths = ['', ...segments.map((_segment, index) => segments.slice(0, index + 1).join('/'))];
  if (value.directories.length !== paths.length) return invalid();
  const directories = value.directories.map((directory, index) => {
    if (!object(directory) || directory.path !== paths[index]) return invalid();
    return Object.freeze({ path: paths[index], ...identity(directory) });
  });
  const captured = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'attachment-removal-local-object' as const,
    collectionName: value.collectionName,
    configuredRoot: value.configuredRoot,
    root: value.root,
    record: Object.freeze({
      key: record.key,
      path: record.path,
      filename: record.filename,
      storageId: record.storageId,
      size: record.size,
    }),
    directories: Object.freeze(directories),
    object: Object.freeze({
      ...identity(value.object),
      mtimeNs: value.object.mtimeNs,
      ctimeNs: value.object.ctimeNs,
      size: value.object.size,
    }),
  });
  if (!isDeepStrictEqual(value, captured)) return invalid();
  return captured;
}
