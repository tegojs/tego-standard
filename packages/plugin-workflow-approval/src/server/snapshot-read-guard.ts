import type { ICollection } from '@tego/server';

export interface ApprovalSnapshotReadRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: Record<string, unknown>;
  readonly context: object;
}

/** Synchronous refusal only; assignee status does not authorize a business read. */
export type ApprovalSnapshotReadGuard = (request: ApprovalSnapshotReadRequest) => void;

export function captureApprovalSnapshotReadGuard(guard?: ApprovalSnapshotReadGuard) {
  if (guard !== undefined && typeof guard !== 'function')
    throw new TypeError('Approval snapshot read guard must be a function');
  if (!guard) return;
  return async (request: ApprovalSnapshotReadRequest) => {
    const result: unknown = guard(Object.freeze(request));
    if (result !== undefined) {
      await result;
      throw new TypeError('Approval snapshot read guard must return undefined synchronously');
    }
  };
}
