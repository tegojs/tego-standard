import { removeLocalStagedAttachment } from './local-recovery';
import { StagedAttachmentJournal } from './staged-journal';
import { StagedAttachmentReceiptJournal } from './staged-receipt-journal';

/**
 * Explicit internal recovery, not a registered worker or endpoint. Never infer deletion permission
 * from an absent business row. Requires stable server-owned local paths with no competing host writers.
 */
export async function recoverStagedAttachment(
  journal: StagedAttachmentJournal,
  receipts: StagedAttachmentReceiptJournal,
  id: string,
): Promise<{ readonly state: 'retained' | 'removed' | 'missing' }> {
  if (!(journal instanceof StagedAttachmentJournal) || !(receipts instanceof StagedAttachmentReceiptJournal))
    throw new TypeError('Attachment recovery requires operation and identity journals');
  receipts.assertIndependentPoolFor(journal.database);
  const recovery = await journal.withCancelledRecovery(id, async (expected) => {
    receipts.assertIndependentPoolFor(journal.database);
    const evidence = await receipts.inspect(id, expected);
    return removeLocalStagedAttachment(expected, evidence.receipt);
  });
  return Object.freeze({ state: recovery.state === 'committed' ? 'retained' : recovery.result });
}

export type StagedAttachmentRecoveryBatchItem =
  | { readonly id: string; readonly state: 'retained' | 'removed' | 'missing' }
  | { readonly id: string; readonly state: 'failed'; readonly error: unknown };

/** Explicit, sequential retry of one discovery page; no worker, automatic loop or time limit.
 * Errors belong to individual operations. Discovery cursors do not prove global completion.
 */
export async function recoverCancelledAttachments(
  journal: StagedAttachmentJournal,
  receipts: StagedAttachmentReceiptJournal,
  options: { after?: string; limit?: number } = {},
): Promise<{ readonly items: readonly StagedAttachmentRecoveryBatchItem[]; readonly nextAfter?: string }> {
  if (!(journal instanceof StagedAttachmentJournal) || !(receipts instanceof StagedAttachmentReceiptJournal))
    throw new TypeError('Attachment recovery requires operation and identity journals');
  receipts.assertIndependentPoolFor(journal.database);
  const ids = await journal.listCancelled(options);
  const items: StagedAttachmentRecoveryBatchItem[] = [];
  for (const id of ids) {
    receipts.assertIndependentPoolFor(journal.database);
    try {
      const result = await recoverStagedAttachment(journal, receipts, id);
      items.push(Object.freeze({ id, state: result.state }));
    } catch (error) {
      items.push(Object.freeze({ id, state: 'failed', error }));
    }
  }
  return Object.freeze({ items: Object.freeze(items), nextAfter: ids[ids.length - 1] });
}
