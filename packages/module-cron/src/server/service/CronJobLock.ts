import { App, Application, Cache, InjectLog, Logger, Service } from '@tego/server';

/**
 * Extended cache interface with optional atomic lock operations
 * 扩展缓存接口，支持可选的原子锁操作
 */
interface CacheClientWithLock extends Cache {
  setIfNotExists?: (key: string, value: unknown, ttl: number) => Promise<boolean>;
  setNx?: (key: string, value: unknown, ttl: number) => Promise<boolean>;
}

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
  // 当前节点的唯一标识，在初始化时生成一次
  private readonly nodeId: string;

  constructor() {
    // 使用进程 ID 和随机数生成节点标识，在构造函数中生成一次并复用
    this.nodeId = `${process.pid}-${Math.random().toString(36).substring(2, 10)}`;
  }

  async load() {
    const cache = this.app?.cache;

    if (!cache) {
      this.logger.error(
        'CronJobLock cache is not initialized. Please ensure cache service is configured before using CronJobLock.',
      );
      throw new Error('CronJobLock cache is not initialized');
    }

    this.cache = cache;
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
      // 设置锁，包含节点标识和时间戳，使用原子操作避免竞态条件
      const lockValue = {
        nodeId: this.getNodeId(),
        acquiredAt: Date.now(),
      };

      const cacheClient = this.cache as CacheClientWithLock;
      let acquired = false;

      // 优先使用支持 "set if not exists" 语义的原子操作
      if (typeof cacheClient.setIfNotExists === 'function') {
        acquired = await cacheClient.setIfNotExists(lockKey, lockValue, lockTTL);
      } else if (typeof cacheClient.setNx === 'function') {
        acquired = await cacheClient.setNx(lockKey, lockValue, lockTTL);
      } else {
        // 如果缓存实现不支持原子 set-if-not-exists，则无法安全地提供分布式锁
        // In this case we do NOT pretend to acquire the lock, to avoid multiple nodes running the same job.
        this.logger.warn(
          'CronJobLock cache implementation does not support atomic set-if-not-exists operations. Distributed locking for cron jobs is disabled. / 当前缓存实现不支持原子性 set-if-not-exists 操作，定时任务的分布式锁已被禁用。',
        );
        throw new Error(
          'CronJobLock cache implementation does not support atomic set-if-not-exists operations',
        );
      }

      if (!acquired) {
        this.logger.debug(`Lock already exists for cron job ${cronJobId} at ${scheduledTime}`);
        return false;
      }

      this.logger.debug(`Lock acquired for cron job ${cronJobId} at ${scheduledTime}`);
      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to acquire lock for cron job ${cronJobId}: ${error.message}`);
        throw error;
      }

      this.logger.error(
        `Failed to acquire lock for cron job ${cronJobId} due to unknown error type`,
        { error },
      );
      throw new Error('Failed to acquire lock due to unknown error');
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
      throw error;
    }
  }

  /**
   * 获取当前节点的唯一标识
   */
  private getNodeId(): string {
    return this.nodeId;
  }
}
