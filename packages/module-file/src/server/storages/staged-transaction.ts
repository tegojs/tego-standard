import { Transaction, type Database } from '@tego/server';

import type { StagedAttachmentUpload } from '../actions/staged-upload';
import {
  prepareStagedAttachmentStorage,
  type StagedAttachmentStorage,
  type StagedAttachmentStorageValues,
} from './staged-upload';

export interface StagedAttachmentPersistence {
  readonly transaction: Transaction;
  readonly values: StagedAttachmentStorageValues;
  /** Invoke once inside the trusted persistence check; do not commit or roll back this transaction. */
  store(): Promise<void>;
}

/** Internal coordination failure, not a public response. Durable recovery is still required before runtime use. */
export class StagedAttachmentTransactionError extends AggregateError {
  readonly recoveryRequired = true;

  constructor(
    readonly phase: 'transaction' | 'commit' | 'rollback' | 'discard',
    errors: unknown[],
  ) {
    super(errors, 'Attachment persistence requires recovery');
  }
}

/**
 * Owns a fresh storage plan and database transaction, not ACL/G or durable compensation.
 * execute must persist and recheck authorized records in this transaction and must not end it.
 * Unknown commit/rollback results preserve the file: deleting it could corrupt a committed record.
 */
export async function withStagedAttachmentTransaction<T>(
  db: Database,
  storage: StagedAttachmentStorage,
  file: StagedAttachmentUpload,
  execute: (input: StagedAttachmentPersistence) => Promise<T>,
): Promise<T> {
  if (typeof execute !== 'function') throw new TypeError('Attachment persistence requires a server executor');
  // Construct privately so a failed second use cannot discard an earlier committed upload's plan.
  const plan = await prepareStagedAttachmentStorage(storage, file);
  if (typeof plan.storeForTransaction !== 'function')
    throw new TypeError('Storage does not support transaction-owned attachment cleanup');
  const store = plan.storeForTransaction.bind(plan);
  // Sequelize exposes finished at runtime but omits it from its public Transaction declaration.
  const transaction = (await db.sequelize.transaction({
    isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
  })) as Transaction & { finished?: string };
  let active = true;
  let writing: Promise<void> | undefined;
  let result: T;
  const input: StagedAttachmentPersistence = Object.freeze({
    values: plan.values,
    transaction,
    store() {
      if (!active || writing || transaction.finished)
        return Promise.reject(new TypeError('Attachment storage is not active or has already started'));
      writing = Promise.resolve().then(store);
      // The owner observes the same promise even if execute forgets to await or swallows its error.
      void writing.catch(() => {});
      return writing;
    },
  });
  try {
    result = await execute(input);
    active = false;
    if (!writing) throw new TypeError('Attachment persistence did not store its file');
    await writing;
    if (transaction.finished) throw new TypeError('Attachment executor ended its owned transaction');
  } catch (error) {
    active = false;
    await writing?.catch(() => {});
    if (transaction.finished) throw new StagedAttachmentTransactionError('transaction', [error]);
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new StagedAttachmentTransactionError('rollback', [error, rollbackError]);
    }
    try {
      await plan.discard();
    } catch (cleanupError) {
      throw new StagedAttachmentTransactionError('discard', [error, cleanupError]);
    }
    throw error;
  }
  try {
    await transaction.commit();
  } catch (error) {
    // Includes an afterCommit hook failure: the row may already be durably committed.
    throw new StagedAttachmentTransactionError('commit', [error]);
  }
  return result;
}
