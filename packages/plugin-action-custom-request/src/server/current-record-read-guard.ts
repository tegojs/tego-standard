import type { Collection, Database } from '@tego/server';

export interface CustomRequestCurrentRecordReadRequest {
  readonly database: Database;
  readonly collectionName: string;
  readonly collection: Collection;
  readonly params: Record<string, unknown>;
  readonly context: object;
}

/** Synchronous refusal only; this does not authorize a custom request's business read. */
export type CustomRequestCurrentRecordReadGuard = (request: CustomRequestCurrentRecordReadRequest) => void;

export function captureCurrentRecordReadGuard(guard?: CustomRequestCurrentRecordReadGuard) {
  if (guard !== undefined && typeof guard !== 'function')
    throw new TypeError('Custom request current-record read guard must be a function');
  return async (request: CustomRequestCurrentRecordReadRequest) => {
    if (!guard) return;
    const result: unknown = guard(Object.freeze(request));
    if (result !== undefined) {
      await result;
      throw new TypeError('Custom request current-record read guard must return undefined synchronously');
    }
  };
}
