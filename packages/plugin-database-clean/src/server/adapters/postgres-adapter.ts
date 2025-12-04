import { Collection } from '@tego/server';

import { QueryTypes } from 'sequelize';

import { BaseDatabaseAdapter, IdRangeInfo, TableSizeInfo, TimeRangeInfo } from './base-adapter';

/**
 * PostgreSQL 数据库适配器
 */
export class PostgresAdapter extends BaseDatabaseAdapter {
  get dialect(): string {
    return 'postgres';
  }

  async getTableSize(collection: Collection): Promise<TableSizeInfo> {
    const schema = collection.collectionSchema() || 'public';
    const tableName = collection.model.tableName;

    const results = (await this.app.db.sequelize.query(
      `SELECT pg_total_relation_size('${schema}."${tableName}"') as total_size`,
      { type: QueryTypes.SELECT },
    )) as Array<{ total_size: string | number }>;

    if (!results || results.length === 0 || !results[0]) {
      throw new Error(`Failed to get table size for ${tableName}`);
    }

    return {
      totalSize: parseInt(String(results[0].total_size), 10) || 0,
    };
  }

  async getRowCount(collection: Collection): Promise<number> {
    const results = (await this.app.db.sequelize.query(
      `SELECT COUNT(*) as count FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`,
      { type: QueryTypes.SELECT },
    )) as Array<{ count: string | number }>;

    if (!results || results.length === 0 || !results[0]) {
      throw new Error(`Failed to get row count for ${collection.name}`);
    }

    return parseInt(String(results[0].count), 10) || 0;
  }

  async getTimeRange(collection: Collection, hasCreatedAt: boolean, hasUpdatedAt: boolean): Promise<TimeRangeInfo> {
    const result: TimeRangeInfo = {
      minCreatedAt: null,
      maxCreatedAt: null,
      maxUpdatedAt: null,
    };

    const tableName = `${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`;

    if (hasCreatedAt) {
      const minResults = (await this.app.db.sequelize.query(`SELECT MIN("createdAt") as min_val FROM ${tableName}`, {
        type: QueryTypes.SELECT,
      })) as Array<{ min_val: Date | null }>;

      if (minResults?.[0]?.min_val) {
        result.minCreatedAt = minResults[0].min_val;
      }

      const maxResults = (await this.app.db.sequelize.query(`SELECT MAX("createdAt") as max_val FROM ${tableName}`, {
        type: QueryTypes.SELECT,
      })) as Array<{ max_val: Date | null }>;

      if (maxResults?.[0]?.max_val) {
        result.maxCreatedAt = maxResults[0].max_val;
      }
    }

    if (hasUpdatedAt) {
      const results = (await this.app.db.sequelize.query(`SELECT MAX("updatedAt") as max_val FROM ${tableName}`, {
        type: QueryTypes.SELECT,
      })) as Array<{ max_val: Date | null }>;

      if (results?.[0]?.max_val) {
        result.maxUpdatedAt = results[0].max_val;
      }
    }

    return result;
  }

  async getIdRange(collection: Collection): Promise<IdRangeInfo> {
    const primaryKey = collection.model.primaryKeyAttribute || 'id';
    const tableName = `${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`;

    try {
      const results = (await this.app.db.sequelize.query(
        `SELECT MIN("${primaryKey}") as min_id, MAX("${primaryKey}") as max_id FROM ${tableName}`,
        { type: QueryTypes.SELECT },
      )) as Array<{ min_id: number | null; max_id: number | null }>;

      if (results?.[0]) {
        return {
          minId: results[0].min_id,
          maxId: results[0].max_id,
        };
      }
    } catch (e) {
      // 忽略错误，可能是主键不是数字类型
    }

    return { minId: null, maxId: null };
  }
}
