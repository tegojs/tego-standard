import type { Collection, Database } from '@tego/server';

export interface CustomRequestCurrentUserReadRequest {
  readonly database: Database;
  readonly collectionName: string;
  readonly collection: Collection;
  readonly params: Record<string, unknown>;
  readonly context: object;
}

/** Synchronous refusal only; being the current user does not authorize associated business reads. */
export type CustomRequestCurrentUserReadGuard = (request: CustomRequestCurrentUserReadRequest) => void;

export function captureCurrentUserReadGuard(guard?: CustomRequestCurrentUserReadGuard) {
  if (guard !== undefined && typeof guard !== 'function')
    throw new TypeError('Custom request current-user read guard must be a function');
  return async (request: CustomRequestCurrentUserReadRequest) => {
    if (!guard) return;
    const result: unknown = guard(Object.freeze(request));
    if (result !== undefined) {
      await result;
      throw new TypeError('Custom request current-user read guard must return undefined synchronously');
    }
  };
}
