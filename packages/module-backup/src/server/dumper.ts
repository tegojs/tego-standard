import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import * as process from 'node:process';
import stream from 'node:stream';
import util from 'node:util';
import { Collection, CollectionGroupManager as DBCollectionGroupManager, DumpRulesGroupType } from '@tego/server';

import archiver from 'archiver';
import dayjs from 'dayjs';
import { default as _, default as lodash } from 'lodash';

import { AppMigrator } from './app-migrator';
import { FieldValueWriter } from './field-value-writer';
import { ProgressManager, ProgressTracker } from './progress-tracker';
import { DUMPED_EXTENSION, humanFileSize, sqlAdapter } from './utils';

const finished = util.promisify(stream.finished);

type DumpOptions = {
  groups: Set<DumpRulesGroupType>;
  fileName?: string;
  appName?: string;
  userId?: number;
};

type BackUpStatusOk = {
  name: string;
  createdAt: Date;
  fileSize: string;
  status: 'ok';
};

type BackUpStatusDoing = {
  name: string;
  inProgress: true;
  status: 'in_progress';
  progress?: number;
  currentStep?: string;
};

type BackUpStatusError = {
  name: string;
  createdAt: Date;
  status: 'error';
};

export class Dumper extends AppMigrator {
  static dumpTasks: Map<string, Promise<any>> = new Map();

  direction = 'dump' as const;

  private get progressManager(): ProgressManager {
    if (!this._progressManager) {
      this._progressManager = new ProgressManager(
        (appName?: string) => this.backUpStorageDir(appName),
        this.workDir,
        this.app,
      );
    }
    return this._progressManager;
  }

  private _progressManager?: ProgressManager;

  sqlContent: {
    [key: string]: {
      sql: string | string[];
      group: DumpRulesGroupType;
    };
  } = {};

  static getTaskPromise(taskId: string): Promise<any> | undefined {
    return this.dumpTasks.get(taskId);
  }

  static async getFileStatus(
    filePath: string,
    appName?: string,
  ): Promise<BackUpStatusOk | BackUpStatusDoing | BackUpStatusError> {
    const lockFile = filePath + '.lock';
    const progressFile = filePath + '.progress';
    const fileName = path.basename(filePath);

    return fs.promises
      .stat(lockFile)
      .then(async (lockFileStat) => {
        if (lockFileStat.isFile()) {
          // 超过2小时认为是失败
          if (lockFileStat.ctime.getTime() < Date.now() - 2 * 60 * 60 * 1000) {
            return {
              name: fileName,
              createdAt: lockFileStat.ctime,
              status: 'error',
            } as BackUpStatusError;
          } else {
            // 尝试读取进度信息
            let progress: { percent: number; currentStep: string } | null = null;
            try {
              const progressContent = await fsPromises.readFile(progressFile, 'utf8');
              progress = JSON.parse(progressContent);
            } catch (error) {
              // 忽略进度文件不存在的错误
            }

            return {
              name: fileName,
              inProgress: true,
              status: 'in_progress',
              progress: progress?.percent,
              currentStep: progress?.currentStep,
            } as BackUpStatusDoing;
          }
        } else {
          throw new Error('Lock file is not a file');
        }
      })
      .catch((error) => {
        // 如果 Lock 文件不存在，检查备份文件
        if (error.code === 'ENOENT') {
          return fs.promises.stat(filePath).then((backupFileStat) => {
            if (backupFileStat.isFile()) {
              return {
                name: fileName,
                createdAt: backupFileStat.ctime,
                fileSize: humanFileSize(backupFileStat.size),
                status: 'ok',
              } as BackUpStatusOk;
            } else {
              throw new Error('Path is not a file');
            }
          });
        }
        // 其他错误直接抛出
        throw error;
      });
  }

  static generateFileName() {
    return `backup_${dayjs().format(`YYYYMMDD_HHmmss_${Math.floor(1000 + Math.random() * 9000)}`)}.${DUMPED_EXTENSION}`;
  }

  writeSQLContent(
    key: string,
    data: {
      sql: string | string[];
      group: DumpRulesGroupType;
    },
  ) {
    this.sqlContent[key] = data;
  }

  getSQLContent(key: string) {
    return this.sqlContent[key];
  }

  async getCollectionsByDataTypes(groups: Set<DumpRulesGroupType>): Promise<string[]> {
    const dumpableCollectionsGroupByDataTypes = await this.collectionsGroupByDataTypes();

    return [...groups].reduce((acc, key) => {
      return acc.concat(dumpableCollectionsGroupByDataTypes[key] || []);
    }, []);
  }

  async dumpableCollections() {
    return (
      await Promise.all(
        [...this.app.db.collections.values()].map(async (c) => {
          try {
            const dumpRules = DBCollectionGroupManager.unifyDumpRules(c.options.dumpRules);

            const options: any = {
              name: c.name,
              title: c.options.title || c.name,
              options: c.options,
              group: dumpRules?.group,
              isView: c.isView(),
              origin: c.origin,
            };

            if (c.options.inherits && c.options.inherits.length > 0) {
              options.inherits = c.options.inherits;
            }

            return options;
          } catch (e) {
            console.error(e);
            throw new Error(`collection ${c.name} has invalid dumpRules option`, { cause: e });
          }
        }),
      )
    ).map((item) => {
      if (!item.group) {
        item.group = 'unknown';
      }

      return item;
    });
  }

  async collectionsGroupByDataTypes() {
    const grouped = lodash.groupBy(await this.dumpableCollections(), 'group');

    return Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.map((item) => item.name)]));
  }

  backUpStorageDir(appName?: string) {
    if (appName && appName !== 'main') {
      return path.resolve(process.env.TEGO_RUNTIME_HOME, 'storage', 'backups', appName);
    }
    return path.resolve(process.env.TEGO_RUNTIME_HOME, 'storage', 'backups');
  }

  async allBackUpFilePaths(options?: { includeInProgress?: boolean; dir?: string; appName?: string }) {
    const dirname = options?.dir || this.backUpStorageDir(options?.appName);
    const includeInProgress = options?.includeInProgress;

    try {
      const files = await fsPromises.readdir(dirname);

      const lockFilesSet = new Set(
        files.filter((file) => path.extname(file) === '.lock').map((file) => path.basename(file, '.lock')),
      );

      const filteredFiles = files
        .filter((file) => {
          const baseName = path.basename(file);
          const isLockFile = path.extname(file) === '.lock';
          const isDumpFile = path.extname(file) === `.${DUMPED_EXTENSION}`;

          return (includeInProgress && isLockFile) || (isDumpFile && !lockFilesSet.has(baseName));
        })
        .map(async (file) => {
          const filePath = path.resolve(dirname, file);
          const stats = await fsPromises.stat(filePath);
          return { filePath, birthtime: stats.birthtime.getTime() };
        });

      const filesData = await Promise.all(filteredFiles);

      filesData.sort((a, b) => b.birthtime - a.birthtime);

      return filesData.map((fileData) => fileData.filePath);
    } catch (error) {
      if (!error.message.includes('no such file or directory')) {
        console.error('Error reading directory:', error);
      }
      return [];
    }
  }

  backUpFilePath(fileName: string, appName?: string) {
    const dirname = this.backUpStorageDir(appName);
    return path.resolve(dirname, fileName);
  }

  lockFilePath(fileName: string, appName?: string) {
    const lockFile = fileName + '.lock';
    const dirname = this.backUpStorageDir(appName);
    return path.resolve(dirname, lockFile);
  }

  async writeLockFile(fileName: string, appName?: string) {
    const dirname = this.backUpStorageDir(appName);
    await fsPromises.mkdir(dirname, { recursive: true });

    const filePath = this.lockFilePath(fileName, appName);
    await fsPromises.writeFile(filePath, 'lock', 'utf8');
    return filePath;
  }

  async cleanLockFile(fileName: string, appName: string) {
    const filePath = this.lockFilePath(fileName, appName);
    await fsPromises.unlink(filePath);
    // 同时清理进度文件
    await this.progressManager.cleanProgressFile(fileName, appName);
  }

  async getLockFile(appName: string) {
    const backupFileName = Dumper.generateFileName();
    await this.writeLockFile(backupFileName, appName);
    return backupFileName;
  }

  async runDumpTask(options: DumpOptions) {
    await this.dump({
      groups: options.groups,
      fileName: options.fileName,
      appName: options.appName,
      userId: options.userId,
    });
  }

  async dumpableCollectionsGroupByGroup() {
    return _(await this.dumpableCollections())
      .map((c) => _.pick(c, ['name', 'group', 'origin', 'title', 'isView', 'inherits']))
      .groupBy('group')
      .mapValues((items) => _.sortBy(items, (item) => item.name))
      .value();
  }

  async dump(options: DumpOptions) {
    const dumpingGroups = options.groups;
    dumpingGroups.add('required');

    const backupFileName = options.fileName || Dumper.generateFileName();
    const progressTracker = this.progressManager.createProgressTracker(backupFileName, options.appName, options.userId);

    // 步骤 1: 准备阶段 (0-5%)
    await progressTracker.update(0, 'Preparing...');

    const delayCollections = new Set();
    const dumpedCollections = await this.getCollectionsByDataTypes(dumpingGroups);
    const totalCollections = dumpedCollections.length;

    // 步骤 2: 备份集合数据 (5-70%)
    for (let i = 0; i < dumpedCollections.length; i++) {
      const collectionName = dumpedCollections[i];
      const collection = this.app.db.getCollection(collectionName);
      if (lodash.get(collection.options, 'dumpRules.delayRestore')) {
        delayCollections.add(collectionName);
      }

      await this.dumpCollection({
        name: collectionName,
      });

      // 更新进度
      const progress = progressTracker.getCollectionProgress(i, totalCollections);
      await progressTracker.update(progress, `Dumping collection: ${collectionName} (${i + 1}/${totalCollections})`);
    }

    // 步骤 3: 备份元数据和数据库特殊内容 (70-90%)
    await progressTracker.update(70, 'Dumping metadata...');
    await this.dumpMeta({
      dumpableCollectionsGroupByGroup: lodash.pick(await this.dumpableCollectionsGroupByGroup(), [...dumpingGroups]),
      dumpedGroups: [...dumpingGroups],
      delayCollections: [...delayCollections],
    });

    await progressTracker.update(75, 'Dumping metadata...');
    await progressTracker.update(80, 'Dumping database content...');
    await this.dumpDb(options, progressTracker);

    // 步骤 4: 打包文件 (90-99%)
    await progressTracker.update(90, 'Packing backup file...');
    const filePath = await this.packDumpedDir(backupFileName, options.appName, progressTracker);
    await this.clearWorkDir();

    // 完成 (100%)
    await progressTracker.update(100, 'Completed');
    // 清理进度文件
    await this.progressManager.cleanProgressFile(backupFileName, options.appName);

    return filePath;
  }

  async dumpDb(options: DumpOptions, progressTracker?: ProgressTracker) {
    const collections = Array.from(this.app.db.collections.values());
    const totalCollections = collections.length;
    let processedCollections = 0;

    for (const collection of collections) {
      const collectionOnDumpOption = this.app.db.collectionFactory.collectionTypes.get(
        collection.constructor as typeof Collection,
      )?.onDump;

      if (collectionOnDumpOption) {
        await collectionOnDumpOption(this, collection);
        processedCollections++;

        // 更新进度
        if (progressTracker && totalCollections > 0) {
          const progress = progressTracker.getDbContentProgress(processedCollections, totalCollections);
          await progressTracker.update(
            progress,
            `Dumping database content... (${processedCollections}/${totalCollections})`,
          );
        }
      }
    }

    if (this.hasSqlContent()) {
      const dbDumpPath = path.resolve(this.workDir, 'sql-content.json');

      await fsPromises.writeFile(
        dbDumpPath,
        JSON.stringify(
          Object.keys(this.sqlContent)
            .filter((key) => options.groups.has(this.sqlContent[key].group))
            .reduce((acc, key) => {
              acc[key] = this.sqlContent[key];
              return acc;
            }, {}),
        ),
        'utf8',
      );
    }

    // 确保进度更新到 88%
    if (progressTracker) {
      await progressTracker.update(88, 'Dumping database content...');
    }
  }

  hasSqlContent() {
    return Object.keys(this.sqlContent).length > 0;
  }

  async dumpMeta(additionalMeta: object = {}) {
    const metaPath = path.resolve(this.workDir, 'meta');

    const metaObj = {
      version: await this.app.version.get(),
      dialect: this.app.db.sequelize.getDialect(),
      DB_UNDERSCORED: process.env.DB_UNDERSCORED,
      DB_TABLE_PREFIX: process.env.DB_TABLE_PREFIX,
      DB_SCHEMA: process.env.DB_SCHEMA,
      COLLECTION_MANAGER_SCHEMA: process.env.COLLECTION_MANAGER_SCHEMA,
      ...additionalMeta,
    };

    if (this.app.db.inDialect('postgres')) {
      if (this.app.db.inheritanceMap.nodes.size > 0) {
        metaObj['dialectOnly'] = true;
      }
    }

    if (this.hasSqlContent()) {
      metaObj['dialectOnly'] = true;
    }

    await fsPromises.writeFile(metaPath, JSON.stringify(metaObj), 'utf8');
  }

  async dumpCollection(options: { name: string }) {
    const app = this.app;
    const dir = this.workDir;
    const collectionName = options.name;
    app.logger.info(`Dumping collection ${collectionName}`);

    const collection = app.db.getCollection(collectionName);
    if (!collection) {
      this.app.logger.warn(`Collection ${collectionName} not found`);
      return;
    }

    const collectionOnDumpOption = this.app.db.collectionFactory.collectionTypes.get(
      collection.constructor as typeof Collection,
    )?.onDump;

    if (collectionOnDumpOption) {
      return;
    }

    // @ts-ignore
    const attributes = collection.model.tableAttributes;
    const columns: string[] = [...new Set(lodash.map(attributes, 'field'))];
    const collectionDataDir = path.resolve(dir, 'collections', collectionName);

    await fsPromises.mkdir(collectionDataDir, { recursive: true });

    let count = 0;
    const dataFilePath = path.resolve(collectionDataDir, 'data');
    const dataStream = fs.createWriteStream(dataFilePath);

    const rows = await app.db.sequelize.query(
      sqlAdapter(app.db, `SELECT * FROM ${collection.isParent() ? 'ONLY' : ''} ${collection.quotedTableName()}`),
      { type: 'SELECT' },
    );

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
    };

    if (collection.options.inherits) {
      meta['inherits'] = lodash.uniq(collection.options.inherits);
    }

    // @ts-ignore 获取 autoIncrement 信息
    const autoIncrAttr = collection.model.autoIncrementAttribute;
    if (autoIncrAttr && collection.model.rawAttributes[autoIncrAttr]?.autoIncrement) {
      const queryInterface = app.db.queryInterface;
      const autoIncrInfo = await queryInterface.getAutoIncrementInfo({
        tableInfo: {
          tableName: collection.model.tableName,
          schema: collection.collectionSchema(),
        },
        fieldName: autoIncrAttr,
      });

      meta['autoIncrement'] = {
        ...autoIncrInfo,
        fieldName: autoIncrAttr,
      };
    }

    // 写入 meta 文件
    await fsPromises.writeFile(path.resolve(collectionDataDir, 'meta'), JSON.stringify(meta), 'utf8');
  }

  async packDumpedDir(fileName: string, appName?: string, progressTracker?: ProgressTracker) {
    const dirname = this.backUpStorageDir(appName);
    await fsPromises.mkdir(dirname, { recursive: true });

    const filePath = path.resolve(dirname, fileName);
    const output = fs.createWriteStream(filePath);

    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    let cleanupProgress: (() => void) | null = null;

    // 如果有进度跟踪器，设置打包进度更新
    if (progressTracker) {
      cleanupProgress = this.progressManager.setupPackingProgress(archive, progressTracker);
    }

    // Create a promise that resolves when the 'close' event is fired
    const app = this.app;
    const onClose = new Promise((resolve, reject) => {
      output.on('close', () => {
        if (app?.logger) {
          app.logger.info(`Backup file created: ${humanFileSize(archive.pointer(), true)}`);
        }
        if (cleanupProgress) {
          cleanupProgress();
        }
        resolve(true);
      });

      output.on('end', () => {
        // Archive stream ended
      });

      archive.on('warning', function (err) {
        if (err.code === 'ENOENT') {
          // log warning
        } else {
          // throw error
          reject(err);
        }
      });

      archive.on('error', function (err) {
        if (cleanupProgress) {
          cleanupProgress();
        }
        reject(err);
      });
    });

    archive.pipe(output);

    archive.directory(this.workDir, false);

    // Finalize the archive
    await archive.finalize();

    // Wait for the 'close' event
    await onClose;

    // 清理进度更新定时器（setupPackingProgress 的 cleanup 函数会在 close 事件中调用）
    // 确保进度更新到 99%（如果还没有更新的话）
    if (progressTracker) {
      await progressTracker.update(99, 'Packing backup file...');
    }

    return {
      filePath,
      dirname,
    };
  }
}
