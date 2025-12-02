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
    const sizeResults = (await this.app.db.sequelize.query(
      `SELECT pg_total_relation_size('${schema}."${tableName}"') as pg_total_relation_size`,
      { type: QueryTypes.SELECT },
    )) as Array<{ pg_total_relation_size: string | number }>;

    if (!sizeResults || sizeResults.length === 0 || !sizeResults[0]) {
      throw new Error(`Failed to get table size for ${tableName}`);
    }
    const size = parseInt(String(sizeResults[0].pg_total_relation_size), 10) || 0;

    // 获取行数
    const countResults = (await this.app.db.sequelize.query(
      `SELECT COUNT(*) as count FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
      { type: QueryTypes.SELECT },
    )) as Array<{ count: string | number }>;

    if (!countResults || countResults.length === 0 || !countResults[0]) {
      throw new Error(`Failed to get row count for ${tableName}`);
    }
    const rowCount = parseInt(String(countResults[0].count), 10) || 0;

    // 获取创建时间和更新时间
    let createdAt: Date | null = null;
    let updatedAt: Date | null = null;

    if (rowCount > 0) {
      // 检查字段是否存在：优先检查 collection.hasField，其次检查 model.rawAttributes
      const rawAttributes = collection.model.rawAttributes || {};
      const hasCreatedAt = collection.hasField('createdAt') || 'createdAt' in rawAttributes;
      const hasUpdatedAt = collection.hasField('updatedAt') || 'updatedAt' in rawAttributes;

      if (hasCreatedAt) {
        const createdAtResults = (await this.app.db.sequelize.query(
          `SELECT MIN("createdAt") as min FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: QueryTypes.SELECT },
        )) as Array<{ min: Date | null }>;
        if (createdAtResults && createdAtResults.length > 0 && createdAtResults[0]) {
          createdAt = createdAtResults[0].min;
        }
      }

      if (hasUpdatedAt) {
        const updatedAtResults = (await this.app.db.sequelize.query(
          `SELECT MAX("updatedAt") as max FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: QueryTypes.SELECT },
        )) as Array<{ max: Date | null }>;
        if (updatedAtResults && updatedAtResults.length > 0 && updatedAtResults[0]) {
          updatedAt = updatedAtResults[0].max;
        }
      } else if (hasCreatedAt) {
        // 如果没有 updatedAt，使用 createdAt 的最大值
        const maxCreatedAtResults = (await this.app.db.sequelize.query(
          `SELECT MAX("createdAt") as max FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: QueryTypes.SELECT },
        )) as Array<{ max: Date | null }>;
        if (maxCreatedAtResults && maxCreatedAtResults.length > 0 && maxCreatedAtResults[0]) {
          updatedAt = maxCreatedAtResults[0].max;
        }
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
