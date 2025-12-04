import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import stream from 'node:stream';
import util from 'node:util';
import { Application, DataTypes, Field } from '@tego/server';

import archiver from 'archiver';
import dayjs from 'dayjs';
import lodash from 'lodash';

import { DatabaseAdapterFactory } from '../adapters';
import { sqlAdapter } from '../utils';

const finished = util.promisify(stream.finished);

export interface BackupFilter {
  createdAt?: {
    $gte?: string;
    $lte?: string;
  };
  updatedAt?: {
    $gte?: string;
    $lte?: string;
  };
  id?: {
    $gte?: number;
    $lte?: number;
  };
}

export interface BackupOptions {
  collectionName: string;
  filter?: BackupFilter;
  fileName?: string;
  appName?: string;
}

// FieldValueWriter 的简化版本（复用 module-backup 的逻辑）
class FieldValueWriter {
  static toDumpedValue(field: Field, val: any) {
    if (val === null) return val;

    if (field.type === 'point' || field.type === 'lineString' || field.type === 'circle' || field.type === 'polygon') {
      const mockObj = {
        getDataValue: () => val,
      };
      const newValue = field.options.get.call(mockObj);
      return newValue;
    }

    return val;
  }
}

export class FilteredBackupService {
  private workDir: string;

  constructor(private app: Application) {
    this.workDir = path.resolve(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'storage', 'temp', 'database-clean');
  }

  /**
   * 生成备份文件名
   */
  static generateFileName(collectionName: string, filter?: BackupFilter): string {
    const random = Math.floor(1000 + Math.random() * 9000);
    const timestamp = dayjs().format('YYYYMMDD_HHmmss');

    // 构建筛选范围后缀
    let rangeSuffix = '';

    if (filter?.createdAt?.$gte || filter?.createdAt?.$lte) {
      const from = filter.createdAt.$gte ? dayjs(filter.createdAt.$gte).format('YYYYMMDD') : 'start';
      const to = filter.createdAt.$lte ? dayjs(filter.createdAt.$lte).format('YYYYMMDD') : 'end';
      rangeSuffix = `_createdAt_${from}_${to}`;
    } else if (filter?.updatedAt?.$gte || filter?.updatedAt?.$lte) {
      const from = filter.updatedAt.$gte ? dayjs(filter.updatedAt.$gte).format('YYYYMMDD') : 'start';
      const to = filter.updatedAt.$lte ? dayjs(filter.updatedAt.$lte).format('YYYYMMDD') : 'end';
      rangeSuffix = `_updatedAt_${from}_${to}`;
    } else if (filter?.id?.$gte !== undefined || filter?.id?.$lte !== undefined) {
      const from = filter.id.$gte !== undefined ? filter.id.$gte : 'start';
      const to = filter.id.$lte !== undefined ? filter.id.$lte : 'end';
      rangeSuffix = `_id_${from}_${to}`;
    }

    return `db-clean_${collectionName}${rangeSuffix}_${timestamp}_${random}.tbdump`;
  }

  /**
   * 备份单个集合的筛选数据
   */
  async backupCollection(options: BackupOptions): Promise<{ fileName: string; filePath: string }> {
    // 检查数据库是否支持（如果不支持会抛出错误）
    DatabaseAdapterFactory.getAdapter(this.app);

    const { collectionName, filter, fileName, appName } = options;
    const collection = this.app.db.getCollection(collectionName);
    if (!collection) {
      throw new Error(`Collection ${collectionName} not found`);
    }

    // 创建临时工作目录
    await fsPromises.mkdir(this.workDir, { recursive: true });

    const collectionDataDir = path.resolve(this.workDir, 'collections', collectionName);
    await fsPromises.mkdir(collectionDataDir, { recursive: true });

    // @ts-ignore
    const attributes = collection.model.tableAttributes;
    const columns: string[] = [...new Set(lodash.map(attributes, 'field') as string[])];

    // 构建 WHERE 条件
    const whereConditions: string[] = [];
    const replacements: any = {};

    if (filter?.createdAt) {
      if (filter.createdAt.$gte) {
        whereConditions.push('"createdAt" >= :createdAtGte');
        replacements.createdAtGte = filter.createdAt.$gte;
      }
      if (filter.createdAt.$lte) {
        whereConditions.push('"createdAt" <= :createdAtLte');
        replacements.createdAtLte = filter.createdAt.$lte;
      }
    }

    if (filter?.updatedAt) {
      if (filter.updatedAt.$gte) {
        whereConditions.push('"updatedAt" >= :updatedAtGte');
        replacements.updatedAtGte = filter.updatedAt.$gte;
      }
      if (filter.updatedAt.$lte) {
        whereConditions.push('"updatedAt" <= :updatedAtLte');
        replacements.updatedAtLte = filter.updatedAt.$lte;
      }
    }

    // ID 范围筛选
    if (filter?.id) {
      const primaryKey = collection.model.primaryKeyAttribute || 'id';
      if (filter.id.$gte !== undefined) {
        whereConditions.push(`"${primaryKey}" >= :idGte`);
        replacements.idGte = filter.id.$gte;
      }
      if (filter.id.$lte !== undefined) {
        whereConditions.push(`"${primaryKey}" <= :idLte`);
        replacements.idLte = filter.id.$lte;
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // 查询数据
    const dataFilePath = path.resolve(collectionDataDir, 'data');
    const dataStream = fs.createWriteStream(dataFilePath);

    let count = 0;
    const sql = `SELECT * FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()} ${whereClause}`;
    const rows = await this.app.db.sequelize.query(sqlAdapter(this.app.db, sql), {
      type: 'SELECT',
      replacements,
    });

    // 写入所有数据
    for (const row of rows) {
      const rowData = JSON.stringify(
        columns.map((col) => {
          const val = row[col];
          const field = collection.getField(col);
          return field ? FieldValueWriter.toDumpedValue(field, val) : val;
        }),
      );

      if (!dataStream.write(rowData + '\r\n', 'utf8')) {
        await new Promise((resolve) => dataStream.once('drain', resolve));
      }

      count++;
    }

    dataStream.end();
    await finished(dataStream);

    // 写入 meta 文件
    const metaAttributes = lodash.mapValues(attributes, (attr, key) => {
      const collectionField = collection.getField(key);
      const fieldOptionKeys = ['field', 'primaryKey', 'autoIncrement', 'allowNull', 'defaultValue', 'unique'];

      if (collectionField) {
        const fieldAttributes: any = {
          field: attr.field,
          isCollectionField: true,
          type: collectionField.type,
          typeOptions: collectionField.options,
        };

        if (fieldAttributes.typeOptions?.defaultValue?.constructor?.name === 'UUIDV4') {
          delete fieldAttributes.typeOptions.defaultValue;
        }

        return fieldAttributes;
      }

      return {
        ...lodash.pick(attr, fieldOptionKeys),
        type: attr.type.constructor.toString(),
        isCollectionField: false,
        typeOptions: attr.type.options,
      };
    });

    const meta = {
      name: collectionName,
      tableName: collection.getTableNameWithSchema(),
      count,
      columns,
      attributes: metaAttributes,
      filter, // 保存筛选条件
    };

    if (collection.options.inherits) {
      meta['inherits'] = lodash.uniq(collection.options.inherits);
    }

    await fsPromises.writeFile(path.resolve(collectionDataDir, 'meta'), JSON.stringify(meta), 'utf8');

    // 写入根 meta 文件（恢复时必须的）
    const rootMeta = {
      version: this.app.getVersion(),
      dialect: this.app.db.sequelize.getDialect(),
      DB_UNDERSCORED: process.env.DB_UNDERSCORED || 'false',
      DB_SCHEMA: process.env.DB_SCHEMA || '',
      COLLECTION_MANAGER_SCHEMA: process.env.COLLECTION_MANAGER_SCHEMA || '',
      DB_TABLE_PREFIX: process.env.DB_TABLE_PREFIX || '',
      // 标记为 database-clean 插件生成的部分备份
      backupType: 'database-clean',
      dumpableCollectionsGroupByGroup: {
        custom: [
          {
            name: collectionName,
            group: 'custom',
            origin: '@tachybase/plugin-database-clean',
            title: collectionName,
            isView: false,
          },
        ],
      },
      dumpedGroups: ['custom'],
      delayCollections: [],
      filter, // 保存筛选条件供参考
    };

    await fsPromises.writeFile(path.resolve(this.workDir, 'meta'), JSON.stringify(rootMeta), 'utf8');

    // 打包文件
    const backupFileName = fileName || FilteredBackupService.generateFileName(collectionName, filter);
    const filePath = await this.packDumpedDir(backupFileName, appName);

    // 清理临时目录
    await this.clearWorkDir();

    return {
      fileName: backupFileName,
      filePath: filePath.filePath,
    };
  }

  private async packDumpedDir(fileName: string, appName?: string) {
    const storageDir = this.getStorageDir(appName);
    await fsPromises.mkdir(storageDir, { recursive: true });

    const filePath = path.resolve(storageDir, fileName);
    const output = fs.createWriteStream(filePath);

    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    const onClose = new Promise<{ filePath: string; dirname: string }>((resolve, reject) => {
      output.on('close', function () {
        resolve({
          filePath,
          dirname: storageDir,
        });
      });

      archive.on('error', function (err) {
        reject(err);
      });
    });

    archive.pipe(output);
    archive.directory(this.workDir, false);
    await archive.finalize();

    await onClose;

    return { filePath, dirname: storageDir };
  }

  private getStorageDir(appName?: string): string {
    if (appName && appName !== 'main') {
      return path.resolve(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'storage', 'backups', appName);
    }
    return path.resolve(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'storage', 'backups');
  }

  private async clearWorkDir() {
    try {
      await fsPromises.rm(this.workDir, { recursive: true, force: true });
    } catch (error) {
      this.app.logger.warn('Failed to clear work directory:', error);
    }
  }
}
