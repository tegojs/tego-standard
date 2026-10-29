import { AttachmentRemovalNativeCapture } from './native-removal-capture';
import { createAttachmentRemovalEvidenceAdapter } from './removal-execution-evidence';
import { AttachmentRemovalIntentJournal } from './removal-intent-journal';

export interface RecordedAttachmentRemovalEntry {
  executeNativeRemoval(evidence: ReturnType<typeof createAttachmentRemovalEvidenceAdapter>): Promise<number>;
}

/** An operation id is correlation only. Unknown never means cancelled, rolled back or safe to retry. */
export class AttachmentRemovalOutcomeError extends AggregateError {
  readonly outcome = 'unknown' as const;

  constructor(
    readonly operationId: string,
    error: unknown,
  ) {
    super([error], 'Attachment removal outcome requires independent inspection');
  }
}

/**
 * Explicit trusted-server composition of the existing owned SQL executor and v3 completion mode.
 * Returns its recorded operation id, or preserves it on a later error (including afterCommit).
 * Never infers rollback from a rejection, retries DELETE, resolves commit itself or touches bytes.
 * Before preparation completes, errors retain their original type and no earlier id is reused.
 * A process crash before the id is delivered still needs separate discovery/correlation support.
 */
export async function executeRecordedAttachmentRemoval(
  entry: RecordedAttachmentRemovalEntry,
  journal: AttachmentRemovalIntentJournal,
  native: AttachmentRemovalNativeCapture,
): Promise<Readonly<{ affected: 1; operationId: string }>> {
  if (!entry || typeof entry.executeNativeRemoval !== 'function')
    throw new TypeError('Recorded attachment removal requires a trusted owned SQL entry');
  const evidence = createAttachmentRemovalEvidenceAdapter(journal, native, { recordCompletion: true });
  let operationId: string | undefined;
  let preparing = false;
  const correlated = Object.freeze({
    async prepare(proof: Parameters<typeof evidence.prepare>[0]) {
      if (preparing) throw new TypeError('Recorded attachment removal preparation has already started');
      preparing = true;
      const session = await evidence.prepare(proof);
      operationId = session.operationId;
      return session;
    },
  });
  try {
    const affected = await entry.executeNativeRemoval(correlated);
    if (affected !== 1 || !operationId)
      throw new TypeError('Recorded attachment removal did not return its single prepared operation');
    return Object.freeze({ affected: 1, operationId });
  } catch (error) {
    if (operationId) throw new AttachmentRemovalOutcomeError(operationId, error);
    throw error;
  }
}
