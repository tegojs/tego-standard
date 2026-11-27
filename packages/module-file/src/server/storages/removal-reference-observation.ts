import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { Database, Transaction } from '@tego/server';

import { isUnsafeLocalAttachmentSegment } from './local-read';
import type { LocalAttachmentRemovalObject } from './local-removal-object';
import { getLocalStorageRoot } from './local-root';
import { validateLocalAttachmentRemovalObject } from './removal-object-validation';
import type { AttachmentRemovalReferenceTable } from './removal-reference-scope';

export interface AttachmentRemovalReferenceObservation {
  readonly state: 'mapped-local-references-observed';
  readonly references: number;
}

const limit = 4096;
const same = (
  stat: BigIntStats,
  expected: Pick<LocalAttachmentRemovalObject['object'], 'dev' | 'ino' | 'birthtimeNs'>,
) =>
  String(stat.dev) === expected.dev &&
  String(stat.ino) === expected.ino &&
  String(stat.birthtimeNs) === expected.birthtimeNs;
const unavailable = (): never => {
  throw new TypeError('Removal reference object changed or is unavailable');
};

async function assertObject(object: LocalAttachmentRemovalObject) {
  try {
    if ((await fs.realpath(object.configuredRoot)) !== object.root) return unavailable();
    const configured = await fs.lstat(object.configuredRoot, { bigint: true });
    if (!configured.isDirectory() || configured.isSymbolicLink()) return unavailable();
    for (const directory of object.directories) {
      const current = await fs.lstat(path.join(object.root, directory.path), { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, directory)) return unavailable();
    }
    const current = await fs.lstat(path.join(object.root, object.record.path, object.record.filename), {
      bigint: true,
    });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      !same(current, object.object) ||
      String(current.mtimeNs) !== object.object.mtimeNs ||
      String(current.ctimeNs) !== object.object.ctimeNs ||
      String(current.size) !== object.object.size
    )
      return unavailable();
  } catch {
    return unavailable();
  }
}

/** Internal fixed observer, called only by the original locked scope. No cleanup authority.
 * Requires stable exclusively server-controlled roots/paths throughout this call. Locks coordinate
 * other database transactions only; they do not protect against filesystem or same-transaction writes.
 */
export async function observeMappedLocalRemovalReferences(
  database: Database,
  sources: readonly AttachmentRemovalReferenceTable[],
  storage: AttachmentRemovalReferenceTable,
  transaction: Transaction,
  assertCurrent: () => Promise<void>,
  input: LocalAttachmentRemovalObject,
): Promise<AttachmentRemovalReferenceObservation> {
  const object = validateLocalAttachmentRemovalObject(input);
  if (!sources.some(({ collectionName }) => collectionName === object.collectionName))
    throw new TypeError('Removal reference object source is outside the registered scope');
  await assertCurrent();
  await assertObject(object);
  await assertCurrent();
  const generator = database.sequelize.getQueryInterface().queryGenerator as unknown as {
    quoteIdentifier(value: string): string;
  };
  const quote = (value: string) => generator.quoteIdentifier(value);
  const table = (entry: AttachmentRemovalReferenceTable) => `${quote(entry.schema)}.${quote(entry.tableName)}`;
  const [stored] = await database.sequelize.query(
    `SELECT ${quote(storage.fields.id)}::text AS id, ${quote(storage.fields.type)} AS type,
      ${quote(storage.fields.options)} AS options FROM ${table(storage)} LIMIT ${limit + 1}`,
    { transaction },
  );
  const configs = stored as { id: string; type: string; options: { documentRoot?: string } }[];
  if (configs.length > limit) throw new TypeError('Removal reference observation exceeds its supported row limit');
  const configured = new Map(configs.map((value) => [value.id, value]));
  const roots = new Map<string, { configured: string; canonical: string; identity: BigIntStats }>();
  let remaining = limit;
  let references = 0;
  const target = path.join(object.root, object.record.path, object.record.filename);
  for (const source of sources) {
    await assertCurrent();
    const [selected] = await database.sequelize.query(
      `SELECT ${quote(source.fields.path)} AS path, ${quote(source.fields.filename)} AS filename,
        ${quote(source.fields.storageId)}::text AS storage FROM ${table(source)} LIMIT ${remaining + 1}`,
      { transaction },
    );
    const rows = selected as { path: string; filename: string; storage: string }[];
    if (rows.length > remaining) throw new TypeError('Removal reference observation exceeds its supported row limit');
    remaining -= rows.length;
    for (const row of rows) {
      if (
        typeof row.path !== 'string' ||
        (row.path !== '' && row.path.split('/').some(isUnsafeLocalAttachmentSegment)) ||
        typeof row.filename !== 'string' ||
        row.filename.includes('/') ||
        isUnsafeLocalAttachmentSegment(row.filename)
      )
        throw new TypeError('Removal reference location is unavailable or unsafe');
      const config = configured.get(row.storage);
      if (
        !config ||
        config.type !== 'local' ||
        !config.options ||
        typeof config.options !== 'object' ||
        Array.isArray(config.options)
      )
        throw new TypeError('Removal reference storage is unavailable or unsupported');
      let root = roots.get(row.storage);
      if (!root) {
        try {
          const configured = getLocalStorageRoot(config);
          const canonical = await fs.realpath(configured);
          const identity = await fs.lstat(configured, { bigint: true });
          if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Unsupported root');
          root = { configured, canonical, identity };
          roots.set(row.storage, root);
        } catch {
          throw new TypeError('Removal reference storage is unavailable or unsupported');
        }
      }
      const candidate = path.join(root.canonical, row.path, row.filename);
      if (path.relative(target, candidate) === '') {
        references++;
        continue;
      }
      try {
        for (const relative of [
          '',
          ...row.path
            .split('/')
            .filter(Boolean)
            .map((_value, index, parts) => parts.slice(0, index + 1).join('/')),
        ]) {
          const directory = await fs.lstat(path.join(root.canonical, relative), { bigint: true });
          if (!directory.isDirectory() || directory.isSymbolicLink())
            throw new TypeError('Removal reference location is unavailable or unsafe');
        }
        const actual = await fs.lstat(candidate, { bigint: true });
        if (!actual.isFile() || actual.isSymbolicLink())
          throw new TypeError('Removal reference location is unavailable or unsafe');
        if (same(actual, object.object)) references++;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code)) throw error;
      }
    }
  }
  await assertCurrent();
  for (const root of roots.values()) {
    const current = await fs.lstat(root.configured, { bigint: true });
    if (
      (await fs.realpath(root.configured)) !== root.canonical ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== root.identity.dev ||
      current.ino !== root.identity.ino ||
      current.birthtimeNs !== root.identity.birthtimeNs
    )
      throw new TypeError('Removal reference storage changed during observation');
  }
  await assertObject(object);
  await assertCurrent();
  return Object.freeze({ state: 'mapped-local-references-observed', references });
}
