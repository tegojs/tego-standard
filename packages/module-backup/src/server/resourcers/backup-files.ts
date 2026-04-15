import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application, DEFAULT_PAGE, DEFAULT_PER_PAGE, koaMulter as multer } from '@tego/server';

import { Dumper } from '../dumper';
import { Restorer } from '../restorer';
import PluginBackupRestoreServer from '../server';

export default {
  name: 'backupFiles',
  middleware: async (ctx, next) => {
    if (ctx.action.actionName !== 'upload') {
      return next();
    }

    const storage = multer.diskStorage({
      destination: os.tmpdir(),
      filename: function (req, file, cb) {
        const randomName = Date.now().toString() + Math.random().toString().slice(2); // 随机生成文件名
        cb(null, randomName);
      },
    });

    const upload = multer({ storage }).single('file');
    return upload(ctx, next);
  },
  actions: {
    async list(ctx, next) {
      const { page = DEFAULT_PAGE, pageSize = DEFAULT_PER_PAGE } = ctx.action.params;

      const dumper = new Dumper(ctx.tego);
      const backupFiles = await dumper.allBackUpFilePaths({
        includeInProgress: true,
        appName: ctx.tego.name,
      });

      // handle pagination
      const count = backupFiles.length;

      const rows = await Promise.all(
        backupFiles.slice((page - 1) * pageSize, page * pageSize).map(async (file) => {
          // if file is lock file, remove lock extension
          return await Dumper.getFileStatus(file.endsWith('.lock') ? file.replace('.lock', '') : file, ctx.tego.name);
        }),
      );

      ctx.body = {
        count,
        rows,
        page: Number(page),
        pageSize: Number(pageSize),
        totalPage: Math.ceil(count / pageSize),
      };

      await next();
    },
    async get(ctx, next) {
      const { filterByTk } = ctx.action.params;
      const dumper = new Dumper(ctx.tego);
      const filePath = dumper.backUpFilePath(filterByTk, ctx.tego.name);

      async function sendError(message, status = 404) {
        ctx.body = { status: 'error', message };
        ctx.status = status;
      }

      try {
        const fileState = await Dumper.getFileStatus(filePath);
        if (fileState.status !== 'ok') {
          await sendError(`Backup file ${filterByTk} not found`);
        } else {
          const restorer = new Restorer(ctx.tego, {
            backUpFilePath: filePath,
          });

          const restoreMeta = await restorer.parseBackupFile();

          ctx.body = {
            ...fileState,
            meta: restoreMeta,
          };
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          await sendError(`Backup file ${filterByTk} not found`);
        }
      }

      await next();
    },

    /**
     * create dump task
     * @param ctx
     * @param next
     */
    async create(ctx, next) {
      const data = <
        {
          dataTypes: string[];
          method;
        }
      >ctx.request.body;

      const app = ctx.tego as Application;
      const userId = ctx.state.currentUser?.id;

      if (data.method === 'worker' && !app.worker?.available) {
        ctx.throw(500, ctx.t('No worker thread', { ns: 'worker-thread' }));
        return next();
      }

      let useWorker = data.method === 'worker' || (data.method === 'priority' && app.worker?.available);
      const dumper = new Dumper(ctx.tego);
      const taskId = await dumper.getLockFile(ctx.tego.name);
      if (useWorker) {
        app.worker
          .callPluginMethod({
            plugin: PluginBackupRestoreServer,
            method: 'workerCreateBackUp',
            params: {
              dataTypes: data.dataTypes,
              appName: ctx.tego.name,
              filename: taskId,
              userId,
            },
            // 目前限制方法并发为1
            concurrency: 1,
          })
          .then((res) => {
            app.noticeManager.notify('backup', { level: 'info', msg: ctx.t('Done', { ns: 'backup' }) });
          })
          .catch((error) => {
            app.noticeManager.notify('backup', { level: 'error', msg: error.message });
          })
          .finally(() => {
            dumper.cleanLockFile(taskId, ctx.tego.name);
          });
      } else {
        const plugin = app.pm.get(PluginBackupRestoreServer) as PluginBackupRestoreServer;
        plugin
          .workerCreateBackUp({
            dataTypes: data.dataTypes,
            appName: ctx.tego.name,
            filename: taskId,
            userId,
          })
          .then((res) => {
            app.noticeManager.notify('backup', { level: 'info', msg: ctx.t('Done', { ns: 'backup' }) });
          })
          .catch((error) => {
            app.noticeManager.notify('backup', { level: 'error', msg: error.message });
          })
          .finally(() => {
            dumper.cleanLockFile(taskId, ctx.tego.name);
          });
      }

      ctx.body = {
        key: taskId,
      };

      await next();
    },

    /**
     * download backup file
     * @param ctx
     * @param next
     */
    async download(ctx, next) {
      const { filterByTk } = ctx.action.params;
      const dumper = new Dumper(ctx.tego);
      const logger = ctx.logger || ctx.tego.logger;
      const startedAt = Date.now();
      const requestId = ctx.get?.('x-request-id') || ctx.state?.requestId;
      const downloadState = {
        requestAborted: false,
      };

      const filePath = dumper.backUpFilePath(filterByTk, ctx.tego.name);

      const fileState = await Dumper.getFileStatus(filePath);

      if (fileState.status !== 'ok') {
        throw new Error(`Backup file ${filterByTk} not found`);
      }

      const stats = await fsPromises.stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`Backup file ${filterByTk} is invalid`);
      }

      const stream = fs.createReadStream(filePath);

      ctx.req.once('aborted', () => {
        downloadState.requestAborted = true;
        logger?.warn('backupFiles:download request aborted', {
          requestId,
          appName: ctx.tego.name,
          fileName: filterByTk,
          filePath,
          durationMs: Date.now() - startedAt,
        });
      });

      ctx.res.once('close', () => {
        if (!ctx.res.writableEnded) {
          logger?.warn('backupFiles:download connection closed before stream finished', {
            requestId,
            appName: ctx.tego.name,
            fileName: filterByTk,
            filePath,
            durationMs: Date.now() - startedAt,
            requestAborted: downloadState.requestAborted,
            responseFinished: ctx.res.writableFinished,
            requestEnded: ctx.req.readableEnded,
            socketDestroyed: ctx.req.socket?.destroyed,
          });
        }
      });

      ctx.res.once('finish', () => {
        logger?.info('backupFiles:download completed', {
          requestId,
          appName: ctx.tego.name,
          fileName: filterByTk,
          durationMs: Date.now() - startedAt,
        });
      });

      stream.once('error', (error) => {
        logger?.error('backupFiles:download stream error', {
          requestId,
          appName: ctx.tego.name,
          fileName: filterByTk,
          filePath,
          error: error?.stack || error?.message || String(error),
        });
      });

      // Help reverse proxies forward file stream directly instead of buffering/chunk rewriting.
      ctx.set('X-Accel-Buffering', 'no');
      ctx.set('Content-Type', 'application/octet-stream');
      ctx.length = stats.size;
      ctx.attachment(filterByTk);
      ctx.body = stream;
      await next();
    },

    async restore(ctx, next) {
      const { dataTypes, filterByTk, key } = ctx.action.params.values;

      const filePath = (() => {
        if (key) {
          const tmpDir = os.tmpdir();
          return path.resolve(tmpDir, key);
        }

        if (filterByTk) {
          const dumper = new Dumper(ctx.tego);
          return dumper.backUpFilePath(filterByTk, ctx.tego.name);
        }
      })();

      if (!filePath) {
        throw new Error(`Backup file ${filterByTk} not found`);
      }

      const args = ['restore', '-f', filePath];

      for (const dataType of dataTypes) {
        args.push('-g', dataType);
      }

      await ctx.tego.runCommand(...args);

      await next();
    },

    async destroy(ctx, next) {
      const { filterByTk } = ctx.action.params;
      const dumper = new Dumper(ctx.tego);
      const filePath = dumper.backUpFilePath(filterByTk, ctx.tego.name);

      await fsPromises.unlink(filePath);

      // remove file
      ctx.body = {
        status: 'ok',
      };
      await next();
    },

    async upload(ctx, next) {
      const file = ctx.file;
      const fileName = file.filename;

      const restorer = new Restorer(ctx.tego, {
        backUpFilePath: file.path,
      });

      const restoreMeta = await restorer.parseBackupFile();

      ctx.body = {
        key: fileName,
        meta: restoreMeta,
      };

      await next();
    },

    async dumpableCollections(ctx, next) {
      ctx.withoutDataWrapping = true;

      const dumper = new Dumper(ctx.tego);

      ctx.body = await dumper.dumpableCollectionsGroupByGroup();

      await next();
    },
  },
};
