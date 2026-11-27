import type { ICollection } from '@tego/server';

export interface ApprovalBusinessWriteRequest {
  readonly actionName: 'create' | 'update';
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: Record<string, unknown>;
  readonly context: object;
}

/** Synchronous refusal only; this does not authorize an approval business write. */
export type ApprovalBusinessWriteGuard = (request: ApprovalBusinessWriteRequest) => void;

export function captureApprovalBusinessWriteGuard(guard?: ApprovalBusinessWriteGuard) {
  if (guard !== undefined && typeof guard !== 'function')
    throw new TypeError('Approval business write guard must be a function');
  return async (request: ApprovalBusinessWriteRequest) => {
    if (!guard) return;
    const result: unknown = guard(Object.freeze(request));
    if (result !== undefined) {
      await result;
      throw new TypeError('Approval business write guard must return undefined synchronously');
    }
  };
}
