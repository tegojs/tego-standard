import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Database } from '@tego/server';

/**
 * 简单的文件锁实现，用于防止并发操作
 */
export class FileLock {
  private lockDir: string;

  constructor(private db: Database) {
    this.lockDir = path.resolve(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'storage', 'locks', 'database-clean');
  }

  /**
   * 获取锁
   */
  async acquire(collectionName: string): Promise<boolean> {
    const lockFile = path.resolve(this.lockDir, `${collectionName}.lock`);
    await fsPromises.mkdir(this.lockDir, { recursive: true });

    try {
      // 尝试创建锁文件（如果文件已存在会抛出错误）
      await fsPromises.writeFile(lockFile, Date.now().toString(), { flag: 'wx' });
      return true;
    } catch (error) {
      // 文件已存在，说明锁被占用
      if (error.code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  /**
   * 释放锁
   */
  async release(collectionName: string): Promise<void> {
    const lockFile = path.resolve(this.lockDir, `${collectionName}.lock`);
    try {
      await fsPromises.unlink(lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 检查锁是否存在
   */
  async isLocked(collectionName: string): Promise<boolean> {
    const lockFile = path.resolve(this.lockDir, `${collectionName}.lock`);
    try {
      await fsPromises.access(lockFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清理过期锁（超过2小时的锁）
   */
  async cleanExpiredLocks(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.lockDir);
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000; // 2小时

      for (const file of files) {
        if (!file.endsWith('.lock')) {
          continue;
        }

        const filePath = path.resolve(this.lockDir, file);
        const stats = await fsPromises.stat(filePath);

        if (now - stats.mtime.getTime() > maxAge) {
          await fsPromises.unlink(filePath);
        }
      }
    } catch (error) {
      // 忽略目录不存在的错误
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
