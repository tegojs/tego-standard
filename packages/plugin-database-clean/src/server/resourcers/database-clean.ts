import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Context, DEFAULT_PAGE, DEFAULT_PER_PAGE, Next } from '@tego/server';

import { WHITELIST_TABLES } from '../constants';
import { DatabaseService } from '../services/database-service';
import { BackupFilter, FilteredBackupService } from '../services/filtered-backup-service';
import { DatabaseCleanLock } from '../utils/lock';

export default {
  name: 'databaseClean',
  actions: {
    /**
     * 获取表列表
     */
    async list(ctx: Context, next: Next) {
      const { page = DEFAULT_PAGE, pageSize = DEFAULT_PER_PAGE, sort } = ctx.action.params;

      const service = new DatabaseService(ctx.app);
      const tables = await service.getWhitelistTables();

      // 排序（默认按 updatedAt 倒序，如果没有则按 createdAt）
      tables.sort((a, b) => {
        const aTime = a.updatedAt || a.createdAt;
        const bTime = b.updatedAt || b.createdAt;
        if (!aTime && !bTime) return 0;
        if (!aTime) return 1;
        if (!bTime) return -1;
        return bTime.getTime() - aTime.getTime();
      });

      // 分页
      const count = tables.length;
      const start = (Number(page) - 1) * Number(pageSize);
      const end = start + Number(pageSize);
      const rows = tables.slice(start, end);

      ctx.body = {
        count,
        rows,
        page: Number(page),
        pageSize: Number(pageSize),
        totalPage: Math.ceil(count / Number(pageSize)),
      };

      await next();
    },

    /**
     * 获取表信息
     */
    async get(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;

      if (!filterByTk) {
        ctx.throw(400, 'Table name is required');
        return;
      }

      const collection = ctx.app.db.getCollection(filterByTk);
      if (!collection) {
        ctx.throw(404, `Collection ${filterByTk} not found`);
        return;
      }

      if (!WHITELIST_TABLES.includes(filterByTk)) {
        ctx.throw(403, `Collection ${filterByTk} is not in whitelist`);
        return;
      }

      const service = new DatabaseService(ctx.app);
      const tableInfo = await service.getTableInfo(filterByTk);

      // 检查字段是否存在：优先检查 collection.hasField，其次检查 model.rawAttributes
      const rawAttributes = collection.model.rawAttributes || {};
      const hasCreatedAt = collection.hasField('createdAt') || 'createdAt' in rawAttributes;
      const hasUpdatedAt = collection.hasField('updatedAt') || 'updatedAt' in rawAttributes;

      ctx.body = {
        ...tableInfo,
        hasCreatedAt,
        hasUpdatedAt,
      };

      await next();
    },

    /**
     * 获取表数据
     */
    async data(ctx: Context, next: Next) {
      const { filterByTk, page = DEFAULT_PAGE, pageSize = DEFAULT_PER_PAGE, filter, sort } = ctx.action.params;

      if (!filterByTk) {
        ctx.throw(400, 'Table name is required');
        return;
      }

      const collection = ctx.app.db.getCollection(filterByTk);
      if (!collection) {
        ctx.throw(404, `Collection ${filterByTk} not found`);
        return;
      }

      if (!WHITELIST_TABLES.includes(filterByTk)) {
        ctx.throw(403, `Collection ${filterByTk} is not in whitelist`);
        return;
      }

      const repository = ctx.app.db.getRepository(filterByTk);
      const limit = Number(pageSize);
      const offset = (Number(page) - 1) * limit;

      // 动态构建排序字段，只使用存在的字段
      let sortFields: string[] = [];
      if (sort) {
        sortFields = Array.isArray(sort) ? sort : [sort];
      } else {
        // 默认排序：优先使用存在的时间字段
        if (collection.hasField('updatedAt')) {
          sortFields.push('-updatedAt');
        }
        if (collection.hasField('createdAt')) {
          sortFields.push('-createdAt');
        }
        // 如果都没有，使用主键倒序
        if (sortFields.length === 0) {
          const primaryKey = collection.model.primaryKeyAttribute || 'id';
          sortFields.push(`-${primaryKey}`);
        }
      }

      const [rows, count] = await repository.findAndCount({
        filter: filter || {},
        limit,
        offset,
        sort: sortFields,
      });

      ctx.body = {
        count,
        rows,
        page: Number(page),
        pageSize: Number(pageSize),
        totalPage: Math.ceil(count / limit),
      };

      await next();
    },

    /**
     * 备份数据
     */
    async backup(ctx: Context, next: Next) {
      const { collectionName, filter } = ctx.action.params.values as {
        collectionName: string;
        filter?: BackupFilter;
      };

      if (!collectionName) {
        ctx.throw(400, 'Collection name is required');
        return;
      }

      const collection = ctx.app.db.getCollection(collectionName);
      if (!collection) {
        ctx.throw(404, `Collection ${collectionName} not found`);
        return;
      }

      if (!WHITELIST_TABLES.includes(collectionName)) {
        ctx.throw(403, `Collection ${collectionName} is not in whitelist`);
        return;
      }

      const lock = new DatabaseCleanLock(ctx.app);
      const locked = await lock.acquire(collectionName);

      if (!locked) {
        ctx.throw(409, `Collection ${collectionName} is being processed`);
        return;
      }

      try {
        const backupService = new FilteredBackupService(ctx.app);
        const result = await backupService.backupCollection({
          collectionName,
          filter,
          appName: ctx.app.name,
        });

        ctx.body = {
          fileName: result.fileName,
          filePath: result.filePath,
          status: 'success',
        };
      } catch (error) {
        ctx.throw(500, `Backup failed: ${error.message}`);
      } finally {
        await lock.release(collectionName);
      }

      await next();
    },

    /**
     * 清理数据
     */
    async clean(ctx: Context, next: Next) {
      const { collectionName, filter } = ctx.action.params.values as {
        collectionName: string;
        filter?: any;
      };

      if (!collectionName) {
        ctx.throw(400, 'Collection name is required');
        return;
      }

      const collection = ctx.app.db.getCollection(collectionName);
      if (!collection) {
        ctx.throw(404, `Collection ${collectionName} not found`);
        return;
      }

      if (!WHITELIST_TABLES.includes(collectionName)) {
        ctx.throw(403, `Collection ${collectionName} is not in whitelist`);
        return;
      }

      const lock = new DatabaseCleanLock(ctx.app);
      const locked = await lock.acquire(collectionName);

      if (!locked) {
        ctx.throw(409, `Collection ${collectionName} is being processed`);
        return;
      }

      try {
        const cleanService = new DatabaseService(ctx.app);
        const result = await cleanService.cleanData({
          collectionName,
          filter,
        });

        ctx.body = {
          deletedCount: result.deletedCount,
          status: 'success',
        };
      } catch (error) {
        ctx.throw(500, `Clean failed: ${error.message}`);
      } finally {
        await lock.release(collectionName);
      }

      await next();
    },

    /**
     * 下载备份文件
     */
    async download(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;

      if (!filterByTk) {
        ctx.throw(400, 'File name is required');
        return;
      }

      const storageDir = path.resolve(
        process.env.TEGO_RUNTIME_HOME || process.cwd(),
        'storage',
        'backups',
        ctx.app.name !== 'main' ? ctx.app.name : '',
      );

      const filePath = path.resolve(storageDir, filterByTk);

      // 检查文件是否存在
      try {
        await fsPromises.access(filePath);
      } catch {
        ctx.throw(404, `Backup file ${filterByTk} not found`);
        return;
      }

      // 检查文件是否是 db-clean 的备份文件
      if (!filterByTk.startsWith('db-clean_')) {
        ctx.throw(403, 'Invalid backup file');
        return;
      }

      const stats = fs.statSync(filePath);
      ctx.set('Content-Length', stats.size.toString());
      ctx.set('Content-Type', 'application/zip');
      ctx.attachment(filterByTk);
      ctx.body = fs.createReadStream(filePath);

      await next();
    },
  },
};
