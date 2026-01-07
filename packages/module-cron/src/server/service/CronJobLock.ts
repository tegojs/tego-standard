import { App, Application, Cache, InjectLog, Logger, Service } from '@tego/server';

/**
 * 基于缓存的分布式锁实现，用于防止定时任务在分布式环境下重复执行
 */
@Service()
export class CronJobLock {
  @App()
  private app: Application;

  @InjectLog()
  private readonly logger: Logger;

  private cache: Cache;
  private readonly LOCK_PREFIX = 'cron-job:lock:';
  // 锁的默认 TTL 为 5 分钟，防止锁无法释放
  private readonly DEFAULT_LOCK_TTL = 5 * 60 * 1000;

  async load() {
    this.cache = this.app.cache;
  }

  /**
   * 生成锁的 key
   * @param cronJobId 任务 ID
   * @param scheduledTime 计划执行时间戳
   */
  private getLockKey(cronJobId: number, scheduledTime: number): string {
    return `${this.LOCK_PREFIX}${cronJobId}:${scheduledTime}`;
  }

  /**
   * 尝试获取锁（原子操作）
   * @param cronJobId 任务 ID
   * @param scheduledTime 计划执行时间戳
   * @param ttl 锁的过期时间（毫秒），默认 5 分钟
   * @returns 是否成功获取锁
   */
  async acquire(cronJobId: number, scheduledTime: number, ttl?: number): Promise<boolean> {
    const lockKey = this.getLockKey(cronJobId, scheduledTime);
    const lockTTL = ttl ?? this.DEFAULT_LOCK_TTL;

    try {
      // 检查锁是否已存在
      const existingLock = await this.cache.get(lockKey);
      if (existingLock) {
        this.logger.debug(`Lock already exists for cron job ${cronJobId} at ${scheduledTime}`);
        return false;
      }

      // 设置锁，包含节点标识和时间戳
      const lockValue = {
        nodeId: this.getNodeId(),
        acquiredAt: Date.now(),
      };

      await this.cache.set(lockKey, lockValue, lockTTL);

      // 再次检查以确保是本节点获取到锁（简单的双重检查）
      const verifyLock = await this.cache.get<{ nodeId: string }>(lockKey);
      if (verifyLock?.nodeId !== lockValue.nodeId) {
        this.logger.debug(`Lock was acquired by another node for cron job ${cronJobId} at ${scheduledTime}`);
        return false;
      }

      this.logger.debug(`Lock acquired for cron job ${cronJobId} at ${scheduledTime}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to acquire lock for cron job ${cronJobId}: ${error.message}`);
      return false;
    }
  }

  /**
   * 释放锁
   * @param cronJobId 任务 ID
   * @param scheduledTime 计划执行时间戳
   */
  async release(cronJobId: number, scheduledTime: number): Promise<void> {
    const lockKey = this.getLockKey(cronJobId, scheduledTime);
    try {
      await this.cache.del(lockKey);
      this.logger.debug(`Lock released for cron job ${cronJobId} at ${scheduledTime}`);
    } catch (error) {
      this.logger.error(`Failed to release lock for cron job ${cronJobId}: ${error.message}`);
    }
  }

  /**
   * 检查锁是否被占用
   * @param cronJobId 任务 ID
   * @param scheduledTime 计划执行时间戳
   */
  async isLocked(cronJobId: number, scheduledTime: number): Promise<boolean> {
    const lockKey = this.getLockKey(cronJobId, scheduledTime);
    try {
      const lock = await this.cache.get(lockKey);
      return !!lock;
    } catch (error) {
      this.logger.error(`Failed to check lock for cron job ${cronJobId}: ${error.message}`);
      return false;
    }
  }

  /**
   * 获取当前节点的唯一标识
   */
  private getNodeId(): string {
    // 使用进程 ID 和随机数生成节点标识
    return `${process.pid}-${Math.random().toString(36).substring(2, 10)}`;
  }
}
