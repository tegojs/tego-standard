import { Transaction, type Database } from '@tego/server';

import type { StagedAttachmentUpload } from '../actions/staged-upload';
import { StagedAttachmentJournal } from './staged-journal';
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
    readonly operationId?: string,
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
  journal?: StagedAttachmentJournal,
): Promise<T> {
  if (typeof execute !== 'function') throw new TypeError('Attachment persistence requires a server executor');
  if (journal !== undefined && (!(journal instanceof StagedAttachmentJournal) || journal.database !== db))
    throw new TypeError('Attachment journal must belong to the owned transaction database');
  // Construct privately so a failed second use cannot discard an earlier committed upload's plan.
  const selectedStorage = journal ? structuredClone(storage) : storage;
  const plan = await prepareStagedAttachmentStorage(selectedStorage, file);
  if (typeof plan.storeForTransaction !== 'function')
    throw new TypeError('Storage does not support transaction-owned attachment cleanup');
  const store = plan.storeForTransaction.bind(plan);
  const operation = journal ? await journal.prepare(selectedStorage, plan.values) : undefined;
  // Sequelize exposes finished at runtime but omits it from its public Transaction declaration.
  const transaction = (await db.sequelize.transaction({
    isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    ...(db.sequelize.getDialect() === 'sqlite' ? { type: Transaction.TYPES.IMMEDIATE } : {}),
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
    if (operation) await operation.lock(transaction);
    result = await execute(input);
    active = false;
    if (!writing) throw new TypeError('Attachment persistence did not store its file');
    await writing;
    if (transaction.finished) throw new TypeError('Attachment executor ended its owned transaction');
    if (operation) await operation.complete(transaction);
  } catch (error) {
    active = false;
    await writing?.catch(() => {});
    if (transaction.finished) throw new StagedAttachmentTransactionError('transaction', [error], operation?.id);
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new StagedAttachmentTransactionError('rollback', [error, rollbackError], operation?.id);
    }
    try {
      await plan.discard();
    } catch (cleanupError) {
      throw new StagedAttachmentTransactionError('discard', [error, cleanupError], operation?.id);
    }
    throw error;
  }
  try {
    await transaction.commit();
  } catch (error) {
    // Includes an afterCommit hook failure: the row may already be durably committed.
    throw new StagedAttachmentTransactionError('commit', [error], operation?.id);
  }
  return result;
}
