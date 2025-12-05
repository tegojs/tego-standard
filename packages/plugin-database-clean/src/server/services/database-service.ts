import { Application } from '@tego/server';

import { BaseDatabaseAdapter, DatabaseAdapterFactory } from '../adapters';
import { WHITELIST_TABLES } from '../constants';

export interface TableInfo {
  name: string;
  origin: string;
  size: number; // 字节数
  rowCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface CleanOptions {
  collectionName: string;
  filter?: any; // Sequelize filter 格式
}

export class DatabaseService {
  private adapter: BaseDatabaseAdapter;

  constructor(private app: Application) {
    // 获取数据库适配器（如果不支持会抛出错误）
    this.adapter = DatabaseAdapterFactory.getAdapter(app);
  }

  /**
   * 获取白名单中的表列表
   */
  async getWhitelistTables(): Promise<TableInfo[]> {
    const tables: TableInfo[] = [];
    const existingCollections = new Set<string>();

    // 获取所有已存在的集合
    for (const collection of this.app.db.collections.values()) {
      if (WHITELIST_TABLES.includes(collection.name)) {
        existingCollections.add(collection.name);
      }
    }

    // 查询每个表的信息
    for (const tableName of WHITELIST_TABLES) {
      if (!existingCollections.has(tableName)) {
        continue;
      }

      const collection = this.app.db.getCollection(tableName);
      if (!collection) {
        continue;
      }

      try {
        const tableInfo = await this.getTableInfo(collection.name);
        tables.push(tableInfo);
      } catch (error) {
        this.app.logger.warn(`Failed to get info for table ${tableName}:`, error);
      }
    }

    return tables;
  }

  /**
   * 获取单个表的信息
   */
  async getTableInfo(collectionName: string): Promise<TableInfo> {
    const collection = this.app.db.getCollection(collectionName);
    if (!collection) {
      throw new Error(`Collection ${collectionName} not found`);
    }

    if (!WHITELIST_TABLES.includes(collectionName)) {
      throw new Error(`Collection ${collectionName} is not in whitelist`);
    }

    // 使用适配器获取表大小
    const sizeInfo = await this.adapter.getTableSize(collection);
    const size = sizeInfo.totalSize;

    // 使用适配器获取行数
    const rowCount = await this.adapter.getRowCount(collection);

    // 获取创建时间和更新时间
    let createdAt: Date | null = null;
    let updatedAt: Date | null = null;

    if (rowCount > 0) {
      // 检查字段是否存在：优先检查 collection.hasField，其次检查 model.rawAttributes
      const rawAttributes = collection.model.rawAttributes || {};
      const hasCreatedAt = collection.hasField('createdAt') || 'createdAt' in rawAttributes;
      const hasUpdatedAt = collection.hasField('updatedAt') || 'updatedAt' in rawAttributes;

      // 使用适配器获取时间范围
      const timeRange = await this.adapter.getTimeRange(collection, hasCreatedAt, hasUpdatedAt);

      createdAt = timeRange.minCreatedAt;
      updatedAt = timeRange.maxUpdatedAt || timeRange.maxCreatedAt;
    }

    return {
      name: collectionName,
      origin: collection.origin || 'unknown',
      size,
      rowCount,
      createdAt,
      updatedAt,
    };
  }

  /**
   * 获取表的 ID 范围
   */
  async getIdRange(collectionName: string): Promise<{ minId: number | null; maxId: number | null }> {
    const collection = this.app.db.getCollection(collectionName);
    if (!collection) {
      throw new Error(`Collection ${collectionName} not found`);
    }

    return await this.adapter.getIdRange(collection);
  }

  /**
   * 清理符合筛选条件的数据
   * 注意：清理操作使用通用的 repository.destroy，不依赖特定数据库
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

    // 使用 repository.destroy 进行删除（通用方法，不依赖特定数据库）
    const result = await repository.destroy({
      filter: filter || {},
    });

    return {
      deletedCount: result,
    };
  }

  /**
   * 执行 VACUUM 操作以释放磁盘空间
   * @param collectionName 集合名称
   * @param full 是否使用 VACUUM FULL（会锁表但真正释放空间）
   */
  async vacuum(collectionName: string, full = false): Promise<void> {
    const collection = this.app.db.getCollection(collectionName);
    if (!collection) {
      throw new Error(`Collection ${collectionName} not found`);
    }

    await this.adapter.vacuum(collection, full);
  }
}
