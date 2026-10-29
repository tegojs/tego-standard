import type { AuthorizedAttachmentRemovalPreparation } from './authorized-removal-storage';
import { AttachmentRemovalNativeCapture } from './native-removal-capture';
import { AttachmentRemovalIntentJournal } from './removal-intent-journal';
import { resolveAttachmentRemovalStorage } from './storage-selection';

type RecordProof = Pick<
  AuthorizedAttachmentRemovalPreparation,
  'collection' | 'transaction' | 'record' | 'assertCurrent'
>;

/** Trusted server composition for the separate tenant SQL executor, never action parameters.
 * Persists preparation and brackets the real Repository DELETE; no file I/O or cleanup permits.
 */
export function createAttachmentRemovalEvidenceAdapter(
  journal: AttachmentRemovalIntentJournal,
  native: AttachmentRemovalNativeCapture,
  options?: { readonly recordCompletion: true },
) {
  if (!(journal instanceof AttachmentRemovalIntentJournal) || !(native instanceof AttachmentRemovalNativeCapture))
    throw new TypeError('Attachment removal execution requires its trusted journal and native capture');
  if (options !== undefined && options.recordCompletion !== true)
    throw new TypeError('Attachment removal completion must be explicitly enabled');
  const recordCompletion = options?.recordCompletion === true;
  return Object.freeze({
    async prepare(proof: RecordProof) {
      const { collection, transaction, record } = proof;
      if (collection.db !== journal.database || typeof proof.assertCurrent !== 'function')
        throw new TypeError('Attachment removal evidence source does not match its journal');
      await native.assertFullRowInstalled(collection, transaction);
      if (recordCompletion) await journal.assertCompletionJournal(collection, transaction);
      await proof.assertCurrent();
      const storage = await resolveAttachmentRemovalStorage(collection, record.storageId, transaction);
      const assertPreparationCurrent = async () => {
        await storage.assertCurrent();
        await proof.assertCurrent();
      };
      await assertPreparationCurrent();
      const handle = await journal.persist(
        Object.freeze({
          ...proof,
          storage: storage.values,
          retainContent: storage.retainContent,
          assertCurrent: assertPreparationCurrent,
        }),
      );
      await assertPreparationCurrent();
      let state: 'prepared' | 'marked' | 'deleted' | 'completed' = 'prepared';
      let observed: Readonly<{ sql: string; rootAlias: string }> | undefined;
      const setting = native.setting;
      const assertCurrent = async () => {
        await native.assertFullRowInstalled(collection, transaction);
        if (recordCompletion) await journal.assertCompletionJournal(collection, transaction);
        await storage.assertCurrent();
      };
      const marker = async () => {
        const [rows] = await journal.database.sequelize.query('SELECT current_setting($setting, true) AS marker', {
          transaction,
          bind: { setting },
        });
        return (rows as { marker: string | null }[])[0]?.marker;
      };
      return Object.freeze({
        /** Correlation only, not a portable deletion or cleanup capability. */
        operationId: handle.id,
        async beforeDelete() {
          if (state !== 'prepared') throw new TypeError('Attachment removal evidence marker has already been used');
          await assertPreparationCurrent();
          await assertCurrent();
          const previous = await marker();
          if (previous !== null && previous !== '')
            throw new TypeError('Attachment removal operation marker is already active');
          await journal.database.sequelize.query('SELECT set_config($setting, $operation, true)', {
            transaction,
            bind: { setting, operation: handle.id },
          });
          state = 'marked';
        },
        async afterDelete() {
          if (state !== 'marked' || (await marker()) !== handle.id)
            throw new TypeError('Attachment removal operation marker changed during deletion');
          await assertCurrent();
          await journal.database.sequelize.query("SELECT set_config($setting, '', true)", {
            transaction,
            bind: { setting },
          });
          state = 'deleted';
        },
        assertCurrent,
        async testPredicate(predicate: { readonly sql: string; readonly rootAlias: string }) {
          if (state !== 'deleted' && state !== 'completed')
            throw new TypeError('Attachment removal evidence is not ready for final verification');
          observed = undefined;
          const captured = Object.freeze({ sql: predicate.sql, rootAlias: predicate.rootAlias });
          await assertCurrent();
          const matches = await (state === 'completed'
            ? journal.testCompletedNativeRowPredicate(handle, native, transaction, captured)
            : journal.testNativeRowPredicate(handle, native, transaction, captured));
          await assertCurrent();
          if (matches) observed = captured;
          return matches;
        },
        ...(recordCompletion
          ? {
              async complete() {
                if (state !== 'deleted' || !observed)
                  throw new TypeError('Attachment removal completion requires successful final observation');
                await assertCurrent();
                await journal.completeNativeRemoval(handle, native, transaction, observed);
                state = 'completed';
                await assertCurrent();
              },
            }
          : {}),
      });
    },
  });
}
