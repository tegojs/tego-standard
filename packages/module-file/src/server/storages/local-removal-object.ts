import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';

import type { AuthorizedAttachmentRemovalPreparation } from './authorized-removal-storage';
import { withLocalAttachmentRead } from './local-read';
import { getLocalStorageRoot } from './local-root';
import type { StagedAttachmentStorage } from './staged-upload';

interface ObjectIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
}

export interface LocalAttachmentRemovalObject {
  readonly schemaVersion: 1;
  readonly kind: 'attachment-removal-local-object';
  readonly collectionName: string;
  readonly configuredRoot: string;
  readonly root: string;
  readonly record: AuthorizedAttachmentRemovalPreparation['record'];
  readonly directories: readonly (ObjectIdentity & { readonly path: string })[];
  readonly object: ObjectIdentity & { readonly mtimeNs: string; readonly ctimeNs: string; readonly size: string };
}

function identity(stat: BigIntStats): ObjectIdentity {
  if (stat.ino <= 0n || stat.birthtimeNs <= 0n)
    throw new TypeError('Existing attachment object identity is unavailable');
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
}

function same(left: BigIntStats, right: ObjectIdentity) {
  return (
    String(left.dev) === right.dev && String(left.ino) === right.ino && String(left.birthtimeNs) === right.birthtimeNs
  );
}

/**
 * Read-only capture inside a trusted destroy/G storage preparation, before any row deletion.
 * Requires stable, exclusively server-owned directories, as does the existing local read opener.
 * Distinct from new-upload receipts: no creation ownership, cancellation, commit or cleanup claim.
 * This detached snapshot is not persistent, a lease, proof of no references or authority to unlink.
 */
export async function captureLocalAttachmentRemovalObject(
  preparation: AuthorizedAttachmentRemovalPreparation,
): Promise<LocalAttachmentRemovalObject> {
  if (!preparation || typeof preparation.assertCurrent !== 'function')
    throw new TypeError('Existing attachment identity requires a trusted removal preparation');
  const record = Object.freeze(structuredClone(preparation.record));
  const storage = structuredClone(preparation.storage) as unknown as StagedAttachmentStorage;
  const collectionName = preparation.collection.name;
  await preparation.assertCurrent();
  const configuredRoot = getLocalStorageRoot(storage);
  return withLocalAttachmentRead(storage, record, async (handle) => {
    await preparation.assertCurrent();
    const opened = await handle.stat({ bigint: true });
    const object = Object.freeze({
      ...identity(opened),
      mtimeNs: String(opened.mtimeNs),
      ctimeNs: String(opened.ctimeNs),
      size: String(opened.size),
    });
    const root = await fs.realpath(configuredRoot);
    const segments = record.path ? record.path.split('/') : [];
    const directories = [] as (ObjectIdentity & { readonly path: string })[];
    for (const relative of ['', ...segments.map((_segment, index) => segments.slice(0, index + 1).join('/'))]) {
      const stat = await fs.lstat(path.join(root, relative), { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new TypeError('Existing attachment directory identity is unavailable');
      directories.push(Object.freeze({ path: relative, ...identity(stat) }));
    }
    await preparation.assertCurrent();
    if ((await fs.realpath(configuredRoot)) !== root)
      throw new TypeError('Existing attachment storage root changed during identity capture');
    for (const directory of directories) {
      const stat = await fs.lstat(path.join(root, directory.path), { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, directory))
        throw new TypeError('Existing attachment directory changed during identity capture');
    }
    const current = await fs.lstat(path.join(root, record.path, record.filename), { bigint: true });
    const settled = await handle.stat({ bigint: true });
    for (const stat of [current, settled]) {
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        !same(stat, object) ||
        String(stat.size) !== object.size ||
        String(stat.mtimeNs) !== object.mtimeNs ||
        String(stat.ctimeNs) !== object.ctimeNs
      )
        throw new TypeError('Existing attachment object changed during identity capture');
    }
    await preparation.assertCurrent();
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: 'attachment-removal-local-object' as const,
      collectionName,
      configuredRoot,
      root,
      record,
      directories: Object.freeze(directories),
      object,
    });
  });
}
