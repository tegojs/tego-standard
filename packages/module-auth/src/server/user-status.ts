import {
  Application,
  Cache,
  Collection,
  SystemLogger,
  type IUserStatusService,
  type UserStatusCache,
  type UserStatusCheckResult,
} from '@tego/server';

import { namespace } from '../preset';
const localeNamespace = namespace;

/**
 * 基础用户状态服务实现
 */
export class UserStatusService implements IUserStatusService {
  protected cache: Cache;
  protected app: Application;
  protected logger: SystemLogger;
  protected userCollection: Collection;
  protected userStatusCollection: Collection;
  protected userStatusHistoryCollection: Collection;

  constructor({ cache, app, logger }: { cache: Cache; app: Application; logger: SystemLogger }) {
    this.cache = cache;
    this.app = app;
    this.logger = logger;
    this.userCollection = app.db.getCollection('users');
    this.userStatusCollection = app.db.getCollection('userStatuses');
    this.userStatusHistoryCollection = app.db.getCollection('userStatusHistories');
  }

  get userRepository() {
    return this.userCollection.repository;
  }

  get userStatusRepository() {
    return this.userStatusCollection.repository;
  }

  get userStatusHistoryRepository() {
    return this.userStatusHistoryCollection.repository;
  }

  /**
   * 翻译消息
   */
  private t(key: string, options?: { ns?: string; lng?: string }): string {
    const language = options?.lng || this.app.i18n?.language || 'en-US';
    return this.app.i18n?.t(key, { ...options, lng: language }) || key;
  }

  async checkUserStatus(userId: number): Promise<UserStatusCheckResult> {
    try {
      // 步骤1: 尝试从缓存获取
      let cached = await this.getUserStatusFromCache(userId);

      // 步骤2: 缓存不存在,从数据库查询
      if (!cached) {
        const user = await this.userRepository.findOne({
          filter: { id: userId },
          fields: ['id', 'status', 'statusExpireAt', 'previousStatus'],
        });

        if (!user) {
          return {
            allowed: false,
            status: 'unknown',
            statusInfo: {
              title: this.t('User not found. Please sign in again to continue.', { ns: localeNamespace }),
              color: 'red',
              allowLogin: false,
            },
            errorMessage: this.t('User not found. Please sign in again to continue.', { ns: localeNamespace }),
            isExpired: false,
          };
        }

        // 构建缓存数据
        cached = {
          userId: user.id,
          status: user.status || 'active',
          expireAt: user.statusExpireAt,
          previousStatus: user.previousStatus,
          lastChecked: new Date(),
        };

        // 写入缓存
        await this.setUserStatusCache(userId, cached);
      }

      // 步骤3: 检查状态是否过期
      if (cached.expireAt && new Date(cached.expireAt) <= new Date()) {
        // 状态已过期,自动恢复
        await this.restoreUserStatus(userId);

        // 重新获取恢复后的状态
        const user = await this.userRepository.findOne({
          filter: { id: userId },
          fields: ['status'],
        });

        cached.status = user.status || 'active';
        cached.expireAt = null;
        cached.previousStatus = null;

        // 更新缓存
        await this.setUserStatusCache(userId, cached);
      }

      // 步骤4: 查询状态定义
      const statusInfo = await this.userStatusRepository.findOne({
        filter: { key: cached.status },
      });

      if (!statusInfo) {
        this.logger.warn(`Status definition not found: ${cached.status}`);
        // 状态定义不存在,阻止登录(状态异常)
        return {
          allowed: false,
          status: cached.status,
          statusInfo: {
            title: this.t('Invalid status', { ns: localeNamespace }),
            color: 'red',
            allowLogin: false,
          },
          errorMessage: this.t('User status is invalid, please contact administrator', { ns: localeNamespace }),
          isExpired: true,
        };
      }

      // 步骤5: 翻译 title 和 loginErrorMessage
      // 数据库中存储的是 {{t("...")}} 格式，需要解析并翻译
      const translateMessage = (message: string): string => {
        if (!message) return '';

        // 匹配 {{t("...")}} 格式
        const match = message.match(/\{\{t\("([^"]+)"\)\}\}/);
        if (match && match[1]) {
          return this.t(match[1], { ns: localeNamespace });
        }

        // 如果不是模板格式，直接返回
        return message;
      };

      const translatedTitle = translateMessage(statusInfo.title);
      const translatedLoginErrorMessage =
        translateMessage(statusInfo.loginErrorMessage) ||
        this.t('User status does not allow login', { ns: localeNamespace });

      // 步骤6: 返回检查结果
      return {
        allowed: statusInfo.allowLogin,
        status: cached.status,
        statusInfo: {
          title: translatedTitle,
          color: statusInfo.color,
          allowLogin: statusInfo.allowLogin,
        },
        errorMessage: translatedLoginErrorMessage || null,
        isExpired: false,
      };
    } catch (error) {
      this.logger.error(`Error checking user status for userId=${userId}: ${error}`);
      // 安全起见, 发生错误时阻止登录
      return {
        allowed: false,
        status: 'unknown',
        statusInfo: {
          title: this.t('Unknown status', { ns: localeNamespace }),
          color: 'red',
          allowLogin: false,
        },
        errorMessage: this.t('System error, please contact administrator', { ns: localeNamespace }),
        isExpired: false,
      };
    }
  }

  async setUserStatusCache(userId: number, data: UserStatusCache): Promise<void> {
    try {
      const cacheKey = this.getUserStatusCacheKey(userId);
      await this.cache.set(cacheKey, JSON.stringify(data), 300 * 1000); // 5分钟过期
    } catch (error) {
      this.logger.error('Error setting user status cache:', error);
    }
  }

  async getUserStatusFromCache(userId: number): Promise<UserStatusCache | null> {
    try {
      const cacheKey = this.getUserStatusCacheKey(userId);
      const cached = await this.cache.get(cacheKey);
      return cached ? (JSON.parse(cached as unknown as string) as UserStatusCache) : null;
    } catch (error) {
      this.logger.error('Error getting user status from cache:', error);
      return null;
    }
  }

  getUserStatusCacheKey(userId: number): string {
    return `userStatus:${userId}`;
  }

  async restoreUserStatus(userId: number): Promise<void> {
    try {
      // 步骤1: 查询用户信息
      const user = await this.userRepository.findOne({
        filter: { id: userId },
        fields: ['id', 'status', 'statusExpireAt', 'previousStatus'],
      });

      if (!user) {
        throw new Error(this.t('User not found. Please sign in again to continue.', { ns: localeNamespace }));
      }

      // 步骤2: 检查是否需要恢复
      if (!user.statusExpireAt || new Date(user.statusExpireAt) > new Date()) {
        // 未过期或没有设置过期时间
        return;
      }

      const oldStatus = user.status;
      const restoreToStatus = user.previousStatus || 'active'; // 默认恢复为 active

      // 步骤3: 开启事务执行恢复
      await this.app.db.sequelize.transaction(async (transaction) => {
        // 先插入历史记录, 不然会被记录为手动
        await this.recordStatusHistoryIfNotExists({
          userId: userId,
          fromStatus: oldStatus,
          toStatus: restoreToStatus,
          reason: this.t('Status expired, auto restored', { ns: localeNamespace }),
          operationType: 'auto',
          createdBy: null,
          expireAt: null,
          transaction,
        });
        // 更新 users 表
        await this.userRepository.update({
          filter: { id: userId },
          values: {
            status: restoreToStatus,
            statusExpireAt: null,
            previousStatus: null,
            statusReason: this.t('Status expired, auto restored', { ns: localeNamespace }),
          },
          transaction,
        });
      });

      // 步骤4: 触发事件
      await this.app.emitAsync('user:statusRestored', {
        userId,
        fromStatus: oldStatus,
        toStatus: restoreToStatus,
      });

      // 步骤6: 记录日志
      this.logger.info(`User status auto restored: userId=${userId}, ${oldStatus} → ${restoreToStatus}`);
    } catch (error) {
      this.logger.error('Error restoring user status:', error);
      throw error;
    }
  }

  async clearUserStatusCache(userId: number): Promise<void> {
    try {
      const cacheKey = this.getUserStatusCacheKey(userId);
      await this.cache.del(cacheKey);
    } catch (error) {
      this.logger.error('Error clearing user status cache:', error);
    }
  }

  async recordStatusHistoryIfNotExists(params: {
    userId: number;
    fromStatus: string;
    toStatus: string;
    reason: string | null;
    expireAt: Date | null;
    operationType: 'manual' | 'auto' | 'system';
    createdBy: number | null;
    transaction?: any;
  }): Promise<void> {
    const { userId, fromStatus, toStatus, reason, expireAt, operationType, createdBy, transaction } = params;

    try {
      // 查询是否已存在相同的记录（最近5秒内）
      const fiveSecondsAgo = new Date(Date.now() - 5000);
      const existing = await this.userStatusHistoryRepository.findOne({
        filter: {
          userId,
          fromStatus,
          toStatus,
          createdAt: {
            $gte: fiveSecondsAgo,
          },
        },
        sort: ['-createdAt'],
        transaction,
      });

      // 如果最近5秒内有相同记录，跳过插入
      if (existing) {
        this.logger.warn(
          `Skipping duplicate history record: userId=${userId}, ${fromStatus} → ${toStatus}, operationType=${operationType}`,
        );
        return;
      }

      // 插入历史记录
      await this.userStatusHistoryRepository.create({
        values: {
          userId,
          fromStatus,
          toStatus,
          reason,
          expireAt,
          operationType,
          createdBy,
        },
        transaction,
      });

      this.logger.debug(
        `History recorded: userId=${userId}, ${fromStatus} → ${toStatus}, operationType=${operationType}`,
      );

      // 清除用户状态缓存（仅在成功插入记录后）
      await this.clearUserStatusCache(userId);
      this.logger.debug(`Cache cleared for userId=${userId}`);
    } catch (error) {
      this.logger.error('Failed to record status history:', error);
      throw error;
    }
  }

  /**
   * 注册用户状态变更拦截器
   * 拦截 users:update 请求,自动记录状态变更历史
   */
  registerStatusChangeInterceptor() {
    const userStatusService = this;

    // 监听 users 表的更新操作
    this.app.db.on('users.beforeUpdate', async (model: any, options: any) => {
      // 检查是否有 status 字段变更
      if (model.changed('status')) {
        const oldStatus = model._previousDataValues.status || 'active';
        const newStatus = model.status;

        // 如果状态确实发生了变化
        if (oldStatus !== newStatus) {
          // 强制设置 previousStatus 为数据库中的旧状态
          model.set('previousStatus', oldStatus);

          // 存储变更信息到 transaction 上下文，供 afterUpdate 使用
          if (!options.transaction) {
            options.transaction = {};
          }
          if (!options.transaction.__statusChange) {
            options.transaction.__statusChange = {};
          }
          options.transaction.__statusChange[model.id] = {
            userId: model.id,
            fromStatus: oldStatus,
            toStatus: newStatus,
            reason: model.statusReason || null,
            expireAt: model.statusExpireAt || null,
          };

          userStatusService.logger.debug(`Status change: userId=${model.id}, ${oldStatus} → ${newStatus}`);
        }
      }
    });

    // 监听 users 表的更新完成
    this.app.db.on('users.afterUpdate', async (model: any, options: any) => {
      // 检查是否有状态变更记录
      const statusChange = options?.transaction?.__statusChange?.[model.id];

      if (statusChange) {
        try {
          // 获取当前操作用户ID
          const currentUserId = options?.context?.state?.currentUser?.id;

          // 记录状态变更历史
          await userStatusService.recordStatusHistoryIfNotExists({
            userId: statusChange.userId,
            fromStatus: statusChange.fromStatus,
            toStatus: statusChange.toStatus,
            reason: statusChange.reason,
            expireAt: statusChange.expireAt,
            operationType: 'manual', // 通过 API 修改的都是手动操作
            createdBy: currentUserId,
            transaction: options.transaction,
          });
        } catch (error) {
          userStatusService.logger.error('Failed to record status history:', error);
        }
      }
    });

    this.logger.info('User status change interceptor registered');
  }
}
