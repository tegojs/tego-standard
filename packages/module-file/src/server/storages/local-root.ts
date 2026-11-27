import path from 'node:path';

import type { StorageModel } from '.';

export function getLocalStorageRoot(storage: Pick<StorageModel, 'options'>): string {
  const { documentRoot = process.env.LOCAL_STORAGE_DEST || 'storage/uploads' } = storage.options || {};
  return path.resolve(
    path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
  );
}
