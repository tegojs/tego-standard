import { getStorageConfig, type StorageModel } from '.';
import type { StagedAttachmentUpload } from '../actions/staged-upload';

export interface StagedAttachmentStorage extends StorageModel {
  id: string | number;
  path: string;
}

export interface StagedAttachmentStorageValues {
  readonly title: string;
  readonly filename: string;
  readonly extname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly path: string;
  readonly url: string;
  readonly storageId: string | number;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface StagedAttachmentStoragePlan {
  readonly values: StagedAttachmentStorageValues;
  /** Copy once while the staged upload still exists. This does not authorize or persist a database row. */
  store(): Promise<void>;
  /** Remove this new object in server-owned, stable storage directories. Safe to repeat after completion. */
  discard(): Promise<void>;
}

/** Server-only storage selection. Unsupported engines must never fall back to immediate legacy upload. */
export async function prepareStagedAttachmentStorage(
  storage: StagedAttachmentStorage,
  file: StagedAttachmentUpload,
): Promise<StagedAttachmentStoragePlan> {
  const capturedStorage = structuredClone(storage);
  const capturedFile = structuredClone(file);
  const adapter = getStorageConfig(capturedStorage.type);
  if (typeof adapter?.prepareStagedUpload !== 'function')
    throw new TypeError('Storage does not support planned attachment uploads');
  return adapter.prepareStagedUpload(capturedStorage, capturedFile);
}
