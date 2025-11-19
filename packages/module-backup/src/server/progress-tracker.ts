import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Application, Gateway } from '@tego/server';

import archiver from 'archiver';

/**
 * 进度信息类型
 */
export type ProgressInfo = {
  percent: number;
  currentStep: string;
};

/**
 * 进度跟踪器接口
 */
export interface ProgressTracker {
  /**
   * 更新进度
   */
  update(percent: number, currentStep: string): Promise<void>;

  /**
   * 计算集合备份阶段的进度 (5-70%)
   */
  getCollectionProgress(currentIndex: number, totalCollections: number): number;

  /**
   * 计算数据库内容备份阶段的进度 (80-88%)
   */
  getDbContentProgress(processedCollections: number, totalCollections: number): number;
}

/**
 * 进度管理器类，负责管理备份过程中的进度文件
 */
export class ProgressManager {
  // 静态标志，用于避免重复警告 WebSocket 不可用（在 worker 线程中很常见）
  private static wsUnavailableWarned = false;

  constructor(
    private backupStorageDir: (appName?: string) => string,
    private workDir: string,
    private app?: Application,
  ) {}

  /**
   * 获取进度文件路径（静态方法，用于不需要实例的场景）
   */
  static getProgressFilePath(filePath: string): string {
    return filePath + '.progress';
  }

  /**
   * 获取进度文件路径
   */
  private progressFilePath(fileName: string, appName?: string): string {
    const progressFile = fileName + '.progress';
    const dirname = this.backupStorageDir(appName);
    return path.resolve(dirname, progressFile);
  }

  /**
   * 通过 WebSocket 推送进度更新
   * @param fileName 备份文件名
   * @param progress 进度信息
   * @param userId 用户ID（可选，如果未提供则不会推送，适用于自动备份场景）
   * @param appName 应用名称
   */
  private pushProgressViaWebSocket(fileName: string, progress: ProgressInfo, userId?: number, appName?: string): void {
    // 如果没有 app 或 userId，静默返回（适用于自动备份等无用户场景）
    if (!this.app) {
      return;
    }

    // 如果没有 userId，说明是自动备份或其他系统任务，不推送 WebSocket
    // 进度信息仍然会写入文件，前端可以通过轮询或刷新获取
    if (!userId || userId <= 0) {
      if (this.app?.logger) {
        this.app.logger.debug(`[ProgressManager] Skipping WebSocket push for ${fileName}: no userId`);
      }
      return;
    }

    try {
      const gateway = Gateway.getInstance();
      const ws = gateway['wsServer'];
      if (!ws) {
        // 只在第一次遇到时警告，避免在 worker 线程中频繁输出警告日志
        if (!ProgressManager.wsUnavailableWarned) {
          ProgressManager.wsUnavailableWarned = true;
          if (this.app?.logger) {
            this.app.logger.warn(
              '[ProgressManager] WebSocket server not available (this is normal in worker threads, progress will be saved to file only)',
            );
          }
        }
        return;
      }

      const finalAppName = appName || this.app.name;
      const tagPrefix = `app:${finalAppName}`;
      const tagValue = `${userId}`;
      const expectedTag = `${tagPrefix}#${tagValue}`;

      // 调试日志：记录发送的消息和标签信息
      if (this.app?.logger) {
        // 检查是否有匹配的连接
        const matchingConnections = Array.from(ws.webSocketClients.values()).filter((client: any) => {
          return client.tags?.has?.(expectedTag);
        });
        this.app.logger.debug(
          `[ProgressManager] Sending backup progress via WebSocket: fileName=${fileName}, userId=${userId}, appName=${finalAppName}, tag=${expectedTag}, progress=${progress.percent}%, matchingConnections=${matchingConnections.length}`,
        );
        if (matchingConnections.length === 0) {
          // 列出所有连接的标签，帮助调试
          const allTags = Array.from(ws.webSocketClients.values())
            .flatMap((client: any) => Array.from(client.tags || []))
            .filter((tag: string) => typeof tag === 'string' && tag.startsWith('app:'));
          this.app.logger.warn(
            `[ProgressManager] No matching connections found for tag ${expectedTag}. Available tags: ${allTags.join(', ')}`,
          );
        }
      }

      // 发送给特定用户
      // 注意：userId 必须有效，否则 sendToConnectionsByTag 可能会报错
      try {
        ws.sendToConnectionsByTag(tagPrefix, tagValue, {
          type: 'backup:progress',
          payload: {
            fileName,
            progress,
          },
        });
      } catch (sendError) {
        // 如果发送失败，记录详细错误信息
        if (this.app?.logger) {
          this.app.logger.error(
            `[ProgressManager] Failed to send WebSocket message: tagPrefix=${tagPrefix}, tagValue=${tagValue}, error=`,
            sendError,
          );
        }
        throw sendError;
      }
    } catch (error) {
      // 记录 WebSocket 推送错误，但不影响备份流程
      if (this.app?.logger) {
        this.app.logger.warn(`[ProgressManager] WebSocket push error for ${fileName} (userId=${userId}):`, error);
      } else {
        console.error(`[ProgressManager] WebSocket push error for ${fileName} (userId=${userId}):`, error);
      }
    }
  }

  /**
   * 写入进度信息
   */
  async writeProgress(fileName: string, progress: ProgressInfo, appName?: string, userId?: number): Promise<void> {
    const filePath = this.progressFilePath(fileName, appName);
    await fsPromises.writeFile(filePath, JSON.stringify(progress), 'utf8');

    // 通过 WebSocket 推送进度更新
    this.pushProgressViaWebSocket(fileName, progress, userId, appName);
  }

  /**
   * 读取进度信息
   */
  async readProgress(fileName: string, appName?: string): Promise<ProgressInfo | null> {
    const filePath = this.progressFilePath(fileName, appName);
    try {
      const content = await fsPromises.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 清理进度文件
   */
  async cleanProgressFile(fileName: string, appName: string): Promise<void> {
    const filePath = this.progressFilePath(fileName, appName);
    try {
      await fsPromises.unlink(filePath);
    } catch (error: any) {
      // 忽略文件不存在的错误
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 创建进度跟踪器
   */
  createProgressTracker(backupFileName: string, appName?: string, userId?: number): ProgressTracker {
    return {
      /**
       * 更新进度
       */
      update: async (percent: number, currentStep: string) => {
        await this.writeProgress(backupFileName, { percent, currentStep }, appName, userId);
      },

      /**
       * 计算集合备份阶段的进度 (5-70%)
       */
      getCollectionProgress: (currentIndex: number, totalCollections: number): number => {
        return 5 + Math.floor(((currentIndex + 1) / totalCollections) * 65);
      },

      /**
       * 计算数据库内容备份阶段的进度 (80-88%)
       */
      getDbContentProgress: (processedCollections: number, totalCollections: number): number => {
        if (totalCollections === 0) return 80;
        return 80 + Math.floor((processedCollections / totalCollections) * 8);
      },
    };
  }

  /**
   * 统计目录中的文件总数
   */
  private async countFiles(dir: string): Promise<number> {
    let count = 0;
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          count += await this.countFiles(fullPath);
        } else {
          count++;
        }
      }
    } catch (error) {
      // 忽略错误，返回当前计数
    }
    return count;
  }

  /**
   * 设置打包阶段的进度更新
   */
  setupPackingProgress(archive: archiver.Archiver, progressTracker: ProgressTracker): () => void {
    let processedEntries = 0;
    let totalEntries = 0;
    let startTime = Date.now();
    let progressInterval: NodeJS.Timeout | null = null;
    let currentProgress = 90;
    let isFinished = false;

    // 估算总文件数（同步等待，避免异步问题）
    this.countFiles(this.workDir)
      .then((count) => {
        totalEntries = count || 1; // 避免除零
      })
      .catch(() => {
        // 如果统计失败，使用默认值
        totalEntries = 1;
      });

    // 监听 entry 事件，跟踪已处理的文件数
    archive.on('entry', () => {
      processedEntries++;
    });

    // 监听 archive 完成事件，确保打包完成后更新进度
    // archiver 会在打包完成时触发 'end' 事件
    const handleFinish = async () => {
      if (isFinished) {
        return; // 避免重复处理
      }
      isFinished = true;
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
      // 打包完成，更新到 99%
      try {
        await progressTracker.update(99, 'Packing backup file...');
      } catch (error) {
        // 记录错误但不抛出，避免影响打包流程
        if (this.app?.logger) {
          this.app.logger.warn('[ProgressManager] Failed to update progress after packing:', error);
        }
      }
    };

    // 监听多个事件以确保打包完成时能正确更新进度
    archive.on('end', handleFinish);
    archive.on('finish', handleFinish);

    // 使用定时器平滑更新进度 (90-99%)
    progressInterval = setInterval(async () => {
      if (isFinished) {
        // 如果已经完成，停止更新
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
        return;
      }

      const elapsed = Date.now() - startTime;

      if (processedEntries > 0 && totalEntries > 0) {
        // 根据已处理的文件数计算进度
        const fileBasedProgress = 90 + Math.floor((processedEntries / totalEntries) * 9);
        // 根据时间估算进度（作为补充，防止文件数统计不准确）
        // 增加时间估算的上限，从10秒改为60秒，避免长时间打包时进度卡住
        const timeBasedProgress = Math.min(90 + Math.floor((elapsed / 60000) * 9), 99);
        // 取两者中的较大值，确保进度不会倒退
        currentProgress = Math.max(currentProgress, Math.min(fileBasedProgress, timeBasedProgress, 99));
      } else {
        // 如果还没有处理文件，根据时间缓慢增加进度
        // 增加时间估算的上限，从10秒改为60秒
        currentProgress = Math.min(90 + Math.floor((elapsed / 60000) * 9), 99);
      }

      // 如果进度已经达到 99%，不再更新（等待完成事件）
      if (currentProgress < 99) {
        await progressTracker.update(currentProgress, 'Packing backup file...');
      }
    }, 300); // 每 300ms 更新一次进度

    // 返回清理函数
    return () => {
      isFinished = true;
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };
  }
}
