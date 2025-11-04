import { Application } from '@tego/server';

import { WHITELIST_TABLES } from '../constants';

export interface CleanOptions {
  collectionName: string;
  filter?: any; // Sequelize filter 格式
}

export class CleanService {
  constructor(private app: Application) {}

  /**
   * 清理符合筛选条件的数据
   */
  async cleanData(options: CleanOptions): Promise<{ deletedCount: number }> {
    const { collectionName, filter } = options;

    const collection = this.app.db.getCollection(collectionName);
    if (!collection) {
      throw new Error(`Collection ${collectionName} not found`);
    }

    if (!WHITELIST_TABLES.includes(collectionName)) {
      throw new Error(`Collection ${collectionName} is not in whitelist`);
    }

    const repository = this.app.db.getRepository(collectionName);

    // 使用 repository.destroy 进行删除
    const result = await repository.destroy({
      filter: filter || {},
    });

    return {
      deletedCount: result,
    };
  }
}
