import { Application } from '@tego/server';

import { QueryTypes } from 'sequelize';

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
  constructor(private app: Application) {}

  /**
   * 获取白名单中的表列表
   */
  async getWhitelistTables(): Promise<TableInfo[]> {
    if (!this.app.db.inDialect('postgres')) {
      throw new Error('Database clean plugin only supports PostgreSQL');
    }

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

    const schema = collection.collectionSchema() || 'public';
    const tableName = collection.model.tableName;

    // 获取表大小（包括索引）
    const [sizeResults] = (await this.app.db.sequelize.query(
      `SELECT pg_total_relation_size('${schema}."${tableName}"') as pg_total_relation_size`,
      { type: QueryTypes.SELECT },
    )) as unknown as [Array<{ pg_total_relation_size: string }>, unknown];
    const size = parseInt(sizeResults[0].pg_total_relation_size, 10);

    // 获取行数
    const [countResults] = (await this.app.db.sequelize.query(
      `SELECT COUNT(*) as count FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
      { type: QueryTypes.SELECT },
    )) as unknown as [Array<{ count: string }>, unknown];
    const rowCount = parseInt(countResults[0].count, 10);

    // 获取创建时间和更新时间
    let createdAt: Date | null = null;
    let updatedAt: Date | null = null;

    if (rowCount > 0) {
      const hasCreatedAt = collection.hasField('createdAt');
      const hasUpdatedAt = collection.hasField('updatedAt');

      if (hasCreatedAt) {
        const [createdAtResults] = (await this.app.db.sequelize.query(
          `SELECT MIN("createdAt") as min FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: QueryTypes.SELECT },
        )) as unknown as [Array<{ min: Date }>, unknown];
        createdAt = createdAtResults[0].min;
      }

      if (hasUpdatedAt) {
        const [updatedAtResults] = (await this.app.db.sequelize.query(
          `SELECT MAX("updatedAt") as max FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: QueryTypes.SELECT },
        )) as unknown as [Array<{ max: Date }>, unknown];
        updatedAt = updatedAtResults[0].max;
      } else if (hasCreatedAt) {
        // 如果没有 updatedAt，使用 createdAt 的最大值
        const [maxCreatedAtResults] = (await this.app.db.sequelize.query(
          `SELECT MAX("createdAt") as max FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: QueryTypes.SELECT },
        )) as unknown as [Array<{ max: Date }>, unknown];
        updatedAt = maxCreatedAtResults[0].max;
      }
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
