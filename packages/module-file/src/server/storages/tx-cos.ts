import { promisify } from 'node:util';

import { AttachmentModel } from '.';
import { STORAGE_TYPE_TX_COS } from '../constants';
import { cloudFilenameGetter } from '../utils';

export default {
  filenameKey: 'url',
  make(storage) {
    const createTxCosStorage = require('multer-cos');
    return new createTxCosStorage({
      cos: storage.options,
      filename: cloudFilenameGetter(storage),
    });
  },
  defaults() {
    return {
      title: '腾讯云对象存储',
      type: STORAGE_TYPE_TX_COS,
      name: 'tx-cos-1',
      baseUrl: ctx.tego.environment.getVariables().TX_COS_STORAGE_BASE_URL,
      options: {
        Region: ctx.tego.environment.getVariables().TX_COS_REGION,
        SecretId: ctx.tego.environment.getVariables().TX_COS_SECRET_ID,
        SecretKey: ctx.tego.environment.getVariables().TX_COS_SECRET_KEY,
        Bucket: ctx.tego.environment.getVariables().TX_COS_BUCKET,
      },
    };
  },
  async delete(storage, records: AttachmentModel[]): Promise<[number, AttachmentModel[]]> {
    const { cos } = this.make(storage);
    const { Deleted } = await promisify(cos.deleteMultipleObject)({
      Region: storage.options.Region,
      Bucket: storage.options.Bucket,
      Objects: records.map((record) => ({ Key: `${record.path}/${record.filename}` })),
    });
    return [
      Deleted.length,
      records.filter((record) => !Deleted.find((item) => item.Key === `${record.path}/${record.filename}`)),
    ];
  },
};
