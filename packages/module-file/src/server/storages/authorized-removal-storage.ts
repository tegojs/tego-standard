import type { Collection, Transaction } from '@tego/server';

import type { LocalAttachmentReadRecord } from './local-read';
import { resolveAttachmentRemovalStorage } from './storage-selection';

interface RemovalRecord extends LocalAttachmentReadRecord {
  readonly key: string | number;
}

/** Trusted destroy/G capability only, never request data or a download/read entry. */
export interface AuthorizedAttachmentRemovalEntry {
  withRecord<T>(
    consume: (proof: {
      readonly collection: Collection;
      readonly transaction: Transaction;
      readonly record: RemovalRecord;
      assertCurrent(): Promise<void>;
    }) => Promise<T>,
    transaction: Transaction,
  ): Promise<T>;
}

export interface AuthorizedAttachmentRemovalPreparation {
  readonly collection: Collection;
  readonly transaction: Transaction;
  readonly record: RemovalRecord;
  /** Detached original storage configuration, for trusted internal consumers only. */
  readonly storage: Record<string, unknown>;
  /** False does not authorize unlink, prove a committed deletion or exclude other references. */
  readonly retainContent: boolean;
  assertCurrent(): Promise<void>;
}

/** Compose record destroy/G with the original storage lock in one caller-owned write transaction.
 * Preparation only: no row deletion, file I/O, durable deletion receipt or route registration.
 * The caller must roll back on error. Await all preparation within the callback.
 */
export async function withAuthorizedAttachmentRemovalStorage<T>(
  entry: AuthorizedAttachmentRemovalEntry,
  transaction: Transaction,
  consume: (preparation: AuthorizedAttachmentRemovalPreparation) => Promise<T>,
): Promise<T> {
  if (!entry || typeof entry.withRecord !== 'function' || typeof consume !== 'function')
    throw new TypeError('Attachment removal preparation requires a trusted destroy entry and consumer');
  return entry.withRecord(async (proof) => {
    if (proof.transaction !== transaction)
      throw new TypeError('Attachment removal proof does not match the caller write transaction');
    const selection = await resolveAttachmentRemovalStorage(proof.collection, proof.record.storageId, transaction);
    const assertCurrent = async () => {
      await selection.assertCurrent();
      await proof.assertCurrent();
    };
    // Selecting/locking storage can wait. Recheck the final record decision before entering the consumer.
    await assertCurrent();
    const result = await consume(
      Object.freeze({
        collection: proof.collection,
        transaction,
        record: proof.record,
        get storage() {
          return selection.values;
        },
        retainContent: selection.retainContent,
        assertCurrent,
      }),
    );
    await assertCurrent();
    return result;
  }, transaction);
}
