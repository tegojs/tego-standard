import { Collection } from '@tego/server';

import { QueryTypes } from 'sequelize';

import { BaseDatabaseAdapter, IdRangeInfo, TableSizeInfo, TimeRangeInfo } from './base-adapter';

/**
 * SQLite 数据库适配器
 */
export class SqliteAdapter extends BaseDatabaseAdapter {
  get dialect(): string {
    return 'sqlite';
  }

  async getTableSize(collection: Collection): Promise<TableSizeInfo> {
    const tableName = collection.model.tableName;

    // SQLite 没有直接获取表大小的方法
    // 使用 dbstat 虚拟表来获取页面信息（需要 SQLite 3.7.9+ 且编译时启用）
    // 如果不可用，则估算大小
    try {
      const results = (await this.app.db.sequelize.query(
        `SELECT SUM(pgsize) as total_size FROM dbstat WHERE name = :tableName`,
        {
          type: QueryTypes.SELECT,
          replacements: { tableName },
        },
      )) as Array<{ total_size: number | null }>;

      if (results?.[0]?.total_size) {
        return { totalSize: results[0].total_size };
      }
    } catch (e) {
      // dbstat 不可用，使用备用方法
    }

    // 备用方法：通过行数估算（每行约 1KB，仅为粗略估计）
    const rowCount = await this.getRowCount(collection);
    return { totalSize: rowCount * 1024 };
  }

  async getRowCount(collection: Collection): Promise<number> {
    const tableName = collection.model.tableName;

    const results = (await this.app.db.sequelize.query(`SELECT COUNT(*) as count FROM "${tableName}"`, {
      type: QueryTypes.SELECT,
    })) as Array<{ count: string | number }>;

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

    const tableName = collection.model.tableName;

    if (hasCreatedAt) {
      const minResults = (await this.app.db.sequelize.query(`SELECT MIN("createdAt") as min_val FROM "${tableName}"`, {
        type: QueryTypes.SELECT,
      })) as Array<{ min_val: string | null }>;

      if (minResults?.[0]?.min_val) {
        result.minCreatedAt = new Date(minResults[0].min_val);
      }

      const maxResults = (await this.app.db.sequelize.query(`SELECT MAX("createdAt") as max_val FROM "${tableName}"`, {
        type: QueryTypes.SELECT,
      })) as Array<{ max_val: string | null }>;

      if (maxResults?.[0]?.max_val) {
        result.maxCreatedAt = new Date(maxResults[0].max_val);
      }
    }

    if (hasUpdatedAt) {
      const results = (await this.app.db.sequelize.query(`SELECT MAX("updatedAt") as max_val FROM "${tableName}"`, {
        type: QueryTypes.SELECT,
      })) as Array<{ max_val: string | null }>;

      if (results?.[0]?.max_val) {
        result.maxUpdatedAt = new Date(results[0].max_val);
      }
    }

    return result;
  }

  async getIdRange(collection: Collection): Promise<IdRangeInfo> {
    const primaryKey = collection.model.primaryKeyAttribute || 'id';
    const tableName = collection.model.tableName;

    try {
      const results = (await this.app.db.sequelize.query(
        `SELECT MIN("${primaryKey}") as min_id, MAX("${primaryKey}") as max_id FROM "${tableName}"`,
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

  async vacuum(collection: Collection, full = false): Promise<void> {
    // SQLite 的 VACUUM 是针对整个数据库的，不能针对单个表
    // VACUUM 会重建整个数据库文件，回收所有未使用的空间
    // 注意：这会锁定整个数据库直到完成
    await this.app.db.sequelize.query('VACUUM');
  }
}
