import { Application } from '@tego/server';

import { WHITELIST_TABLES } from '../constants';

export interface TableInfo {
  name: string;
  origin: string;
  size: number; // 字节数
  rowCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export class DatabaseCleanService {
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
    const [sizeResult] = await this.app.db.sequelize.query<[{ pg_total_relation_size: string }]>(
      `SELECT pg_total_relation_size('${schema}."${tableName}"') as pg_total_relation_size`,
      { type: 'SELECT' },
    );
    const size = parseInt(sizeResult.pg_total_relation_size, 10);

    // 获取行数
    const [countResult] = await this.app.db.sequelize.query<[{ count: string }]>(
      `SELECT COUNT(*) as count FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
      { type: 'SELECT' },
    );
    const rowCount = parseInt(countResult.count, 10);

    // 获取创建时间和更新时间
    let createdAt: Date | null = null;
    let updatedAt: Date | null = null;

    if (rowCount > 0) {
      const hasCreatedAt = collection.hasField('createdAt');
      const hasUpdatedAt = collection.hasField('updatedAt');

      if (hasCreatedAt) {
        const [createdAtResult] = await this.app.db.sequelize.query<[{ min: Date }]>(
          `SELECT MIN("createdAt") as min FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: 'SELECT' },
        );
        createdAt = createdAtResult.min;
      }

      if (hasUpdatedAt) {
        const [updatedAtResult] = await this.app.db.sequelize.query<[{ max: Date }]>(
          `SELECT MAX("updatedAt") as max FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: 'SELECT' },
        );
        updatedAt = updatedAtResult.max;
      } else if (hasCreatedAt) {
        // 如果没有 updatedAt，使用 createdAt 的最大值
        const [maxCreatedAtResult] = await this.app.db.sequelize.query<[{ max: Date }]>(
          `SELECT MAX("createdAt") as max FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
          { type: 'SELECT' },
        );
        updatedAt = maxCreatedAtResult.max;
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
}
