import type { FileHandle } from 'node:fs/promises';
import type { Collection } from '@tego/server';

import { withLocalAttachmentRead, type LocalAttachmentReadRecord } from './local-read';
import { renderStagedAttachmentStorage, resolveAttachmentReadStorage } from './storage-selection';

/** Trusted server capability from the final record authorizer, never request data or a transport DTO. */
export interface AuthorizedAttachmentReadEntry {
  withRecord<T>(
    consume: (proof: {
      readonly collection: Collection;
      readonly record: LocalAttachmentReadRecord;
      assertCurrent(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

/** No route registration. Await consumption here; do not return handles or unconsumed streams. */
export async function withAuthorizedLocalAttachmentRead<T>(
  entry: AuthorizedAttachmentReadEntry,
  render: (values: Record<string, unknown>) => unknown,
  consume: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  if (!entry || typeof entry.withRecord !== 'function' || typeof render !== 'function' || typeof consume !== 'function')
    throw new TypeError('Attachment content reading requires a trusted entry, renderer and consumer');
  return entry.withRecord(async (proof) => {
    await proof.assertCurrent();
    const selection = await resolveAttachmentReadStorage(proof.collection, proof.record.storageId);
    await proof.assertCurrent();
    // Existing files use their stored path, never a new upload path or the viewer's tenant directory.
    const storage = renderStagedAttachmentStorage(selection, render);
    await selection.assertCurrent();
    await proof.assertCurrent();
    return withLocalAttachmentRead(storage, proof.record, async (handle) => {
      // Opening a file may wait. No bytes reach the consumer until these final checks finish.
      await selection.assertCurrent();
      await proof.assertCurrent();
      return consume(handle);
    });
  });
}
