import { Application, Cache } from '@tego/server';

/**
 * 基于缓存的锁实现，用于防止并发操作
 */
export class DatabaseCleanLock {
  private cache: Cache;
  private readonly LOCK_PREFIX = 'database-clean:lock:';
  private readonly LOCK_TTL = 2 * 60 * 60 * 1000; // 2小时

  constructor(private app: Application) {
    this.cache = app.cache;
  }

  /**
   * 获取锁
   */
  async acquire(collectionName: string): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${collectionName}`;

    // 尝试获取锁
    const existingLock = await this.cache.get(lockKey);
    if (existingLock) {
      return false; // 锁已被占用
    }

    // 设置锁，使用 TTL 自动过期
    await this.cache.set(lockKey, Date.now(), this.LOCK_TTL);
    return true;
  }

  /**
   * 释放锁
   */
  async release(collectionName: string): Promise<void> {
    const lockKey = `${this.LOCK_PREFIX}${collectionName}`;
    await this.cache.del(lockKey);
  }

  /**
   * 检查锁是否存在
   */
  async isLocked(collectionName: string): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${collectionName}`;
    const lock = await this.cache.get(lockKey);
    return !!lock;
  }
}
