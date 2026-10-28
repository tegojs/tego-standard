import { Model } from '@tego/server';

import type { StorageModel } from './storages';

/** Existing file presentation shared by Model JSON and bounded staged-upload responses. */
export function applyFilePresentation(
  json: Record<string, unknown>,
  storage: Pick<StorageModel, 'type' | 'options'>,
  publicPath?: string,
) {
  json['thumbnailRule'] = storage?.options?.thumbnailRule;
  if (!json['thumbnailRule'] && storage?.type === 'ali-oss') {
    json['thumbnailRule'] = '?x-oss-process=image/auto-orient,1/resize,m_fill,w_94,h_94/quality,q_90';
  }
  if (storage?.type === 'local' && publicPath) {
    json['url'] = publicPath.replace(/\/$/g, '') + json.url;
  }
  return json;
}

export class FileModel extends Model {
  public toJSON() {
    const json = super.toJSON();
    const fileStorages = this.constructor['database']?.['_fileStorages'];
    if (json.storageId && fileStorages && fileStorages.has(json.storageId)) {
      const storage = fileStorages.get(json.storageId);
      applyFilePresentation(json, storage, process.env.APP_PUBLIC_PATH);
    }
    return json;
  }
}
