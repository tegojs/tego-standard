import { AttachmentRemovalNativeCapture } from '../../storages/native-removal-capture';
import { executeRecordedAttachmentRemoval } from '../../storages/recorded-removal';
import { AttachmentRemovalIntentJournal } from '../../storages/removal-intent-journal';
import { captureCrashProducer, crashFixtureDatabase } from './removal-crash-context';

async function main() {
  const phase = process.env.TENANT_REMOVAL_CRASH_PHASE;
  if (!['uncommitted', 'committed'].includes(phase) || !process.send)
    throw new TypeError('Unknown producer crash fixture phase or missing IPC');
  const db = crashFixtureDatabase(process.env.TENANT_ACCESS_TEST_DATABASE_URL!);
  try {
    const { source, intents, events, entry } = await captureCrashProducer(db);
    const pause = async () => {
      // No operation id, result, error object or journal payload crosses this process boundary.
      await new Promise<void>((resolve, reject) =>
        process.send!({ phase }, (error) => (error ? reject(error) : resolve())),
      );
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await new Promise<never>(() => {});
      } finally {
        clearInterval(keepAlive);
      }
    };
    source.model.addHook('afterDestroy', async (_row, { transaction }) => {
      if (phase === 'uncommitted') await pause();
      else transaction.afterCommit(pause);
    });
    await executeRecordedAttachmentRemoval(
      entry,
      new AttachmentRemovalIntentJournal(intents),
      new AttachmentRemovalNativeCapture(source, events, 'full-row'),
    );
    throw new Error('Producer unexpectedly delivered its result');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  // A failing test can inspect diagnostics, but never receives the outcome object's operationId.
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
