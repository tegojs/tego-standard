import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database } from '@tego/server';

import type { LocalAttachmentRemovalObject } from '../../storages/local-removal-object';
import type { AttachmentRemovalCompletionInspector } from '../../storages/removal-completion-inspector';
import { openReadOnlyRemovalFixtureSession } from './removal-session-client';

/** New-fixture rehearsal only. Never accepts an action, callback or cleanup capability. */
export async function openOwnedReadOnlyRemovalFixture(
  directory: string,
  pool: { db: Database; inspector: AttachmentRemovalCompletionInspector },
  objects: Collection,
) {
  const session = await openReadOnlyRemovalFixtureSession(directory).catch(async (error) => {
    await pool.db.close();
    throw error;
  });
  let claimed = false;
  let invalid = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let finalConsumed = false;
  let finalProbeCalls = 0;
  let finishedNormally = false;
  let original: unknown;
  const assertActive = () => {
    if (invalid) throw new Error('Owned fixture session ended');
  };
  const close = () => {
    closing ??= (async () => {
      invalid = true;
      try {
        if (finishedNormally) await session.close();
        else await session.terminate();
      } finally {
        await pool.db.close();
      }
      closed = true;
    })();
    return closing;
  };
  const sameFields = (actual: object, expected: object) => {
    for (const key of Object.keys(expected))
      if (!isDeepStrictEqual(Reflect.get(actual, key), Reflect.get(expected, key)))
        throw new Error('Owned fixture identity changed');
  };
  const checkNative = (actual: typeof session.initial, object: LocalAttachmentRemovalObject) => {
    if (!isDeepStrictEqual(actual, session.initial)) throw new Error('Owned fixture live binding changed');
    sameFields(actual.file, { ...object.object, nlink: '1', directory: false, reparse: false });
    if (object.directories.length !== 2 || actual.directories.length !== 3)
      throw new Error('Owned fixture directory chain changed');
    for (const [index, entry] of object.directories.entries()) {
      if (entry.path !== (index === 0 ? '' : 'nested')) throw new Error('Owned fixture directory path changed');
      sameFields(actual.directories[index + 1], {
        dev: entry.dev,
        ino: entry.ino,
        birthtimeNs: entry.birthtimeNs,
        directory: true,
        reparse: false,
      });
    }
  };
  const binding = async (operationId: string) => {
    assertActive();
    const row = await objects.model.findByPk(operationId);
    assertActive();
    const payload = row?.getDataValue('payload') as
      | {
          schemaVersion: number;
          kind: string;
          object: LocalAttachmentRemovalObject;
        }
      | undefined;
    const object = payload?.object;
    if (
      payload?.schemaVersion !== 1 ||
      payload.kind !== 'attachment-removal-bound-local-object' ||
      object?.schemaVersion !== 1 ||
      object.kind !== 'attachment-removal-local-object' ||
      object.root !== path.join(directory, 'root') ||
      object.configuredRoot !== path.join(directory, 'root') ||
      object.record.path !== 'nested' ||
      object.record.filename !== 'attachment.txt'
    )
      throw new Error('Owned fixture requires its actual fixed object binding');
    if (original === undefined) original = structuredClone(payload);
    else if (!isDeepStrictEqual(original, payload)) throw new Error('Owned fixture persisted binding changed');
    checkNative(await session.observe(), object);
    assertActive();
    return object;
  };
  return {
    async recordOnce(operationId: string) {
      // Consume the original invocation synchronously, before any await or record call.
      if (claimed) throw new Error('Owned fixture already claimed');
      claimed = true;
      try {
        assertActive();
        await binding(operationId);
        const recorded = await pool.inspector.recordLocalCleanupAttempt(operationId);
        assertActive();
        if (recorded.state !== 'committed-cleanup-attempt-recorded' || recorded.operationId !== operationId)
          throw new Error('Owned fixture attempt was not normally confirmed');
        const historical = await pool.inspector.inspectLocalCleanupAttempt(operationId);
        assertActive();
        if (
          historical.state !== 'committed-cleanup-attempt-observed' ||
          historical.operationId !== operationId ||
          historical.attemptId !== recorded.attemptId ||
          historical.transactionId !== recorded.transactionId ||
          historical.reservationTransactionId !== recorded.reservationTransactionId ||
          historical.removalTransactionId !== recorded.removalTransactionId
        )
          throw new Error('Owned fixture requires the same committed attempt');
        const object = await binding(operationId);
        assertActive();
        if (finalConsumed) throw new Error('Owned fixture final probe already consumed');
        // This is only a local read-only send boundary, not a broker action or lease.
        finalConsumed = true;
        finalProbeCalls++;
        checkNative(await session.observe(), object);
        assertActive();
        finishedNormally = true;
        return Object.freeze({
          state: 'read-only-attempt-rehearsed' as const,
          operationId,
          attemptId: recorded.attemptId,
        });
      } finally {
        await close();
      }
    },
    // Test fault: terminates only the privately owned broker; it never substitutes an observation.
    async terminateNative() {
      invalid = true;
      await session.terminate();
    },
    snapshot: () => Object.freeze({ claimed, closed, finalConsumed, finalProbeCalls }),
    close,
  };
}
