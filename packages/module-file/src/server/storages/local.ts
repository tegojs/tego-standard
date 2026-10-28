import { mkdir } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import multer from 'multer';

import { AttachmentModel } from '.';
import { STORAGE_TYPE_LOCAL } from '../constants';
import { getFilename } from '../utils';
import { getLocalStorageRoot as getDocumentRoot } from './local-root';
import { prepareLocalStagedUpload } from './local-upload';

export default {
  prepareStagedUpload: prepareLocalStagedUpload,
  make(storage) {
    return multer.diskStorage({
      destination: function (req, file, cb) {
        const destPath = path.join(getDocumentRoot(storage), storage.path);
        mkdir(destPath, { recursive: true }, (err: Error | null) => cb(err, destPath));
      },
      filename: getFilename,
    });
  },
  defaults() {
    return {
      title: 'Local storage',
      type: STORAGE_TYPE_LOCAL,
      name: `local`,
      baseUrl: '/storage/uploads',
      options: {
        documentRoot: 'storage/uploads',
      },
    };
  },
  async delete(storage, records: AttachmentModel[]): Promise<[number, AttachmentModel[]]> {
    const documentRoot = getDocumentRoot(storage);
    let count = 0;
    const undeleted = [];
    await records.reduce(
      (promise, record) =>
        promise.then(async () => {
          try {
            await fs.unlink(path.join(documentRoot, record.path, record.filename));
            count += 1;
          } catch (ex) {
            if (ex.code === 'ENOENT') {
              console.warn(ex.message);
              count += 1;
            } else {
              console.error(ex);
              undeleted.push(record);
            }
          }
        }),
      Promise.resolve(),
    );

    return [count, undeleted];
  },
};
