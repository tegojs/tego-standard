import { Application, AuthErrorCode, BaseAuth, Cache, Database, Model } from '@tego/server';

import { namespace } from '../preset';

/**
 * 用户状态检查结果
 */
export interface UserStatusCheckResult {
  allowed: boolean; // 是否允许登录
  status: string; // 当前状态 key
  statusInfo?: {
    // 状态详细信息
    title: string;
    color: string;
    allowLogin: boolean;
    loginErrorMessage?: string;
  };
  errorMessage?: string; // 不允许登录时的错误提示
  isExpired?: boolean; // 状态是否已过期
}

/**
 * 修改用户状态的选项
 */
export interface ChangeUserStatusOptions {
  expireAt?: Date; // 状态过期时间
  reason?: string; // 变更原因
  operationType: 'manual' | 'auto' | 'system'; // 操作类型
  operatorId?: number; // 操作人ID (manual 时必填)
}

/**
 * 状态注册配置
 */
export interface StatusConfig {
  key: string; // 状态唯一标识
  title: string; // 状态显示名称(支持国际化)
  color?: string; // 颜色标识
  allowLogin: boolean; // 是否允许登录
  loginErrorMessage?: string; // 登录错误提示
  packageName: string; // 定义该状态的插件包名
  description?: string; // 状态描述
  sort?: number; // 排序权重
  config?: Record<string, any>; // 扩展配置
}

/**
 * 用户状态缓存数据
 */
interface UserStatusCache {
  userId: number;
  status: string;
  expireAt: Date | null;
  previousStatus: string | null;
  lastChecked: Date;
}

/**
 * 用户状态管理服务
 * 负责用户状态的检查、变更、恢复等核心业务逻辑
 */
export class UserStatusService {
  private db: Database;
  private app: Application;
  private cache: Cache;
  private logger: any;

  constructor(app: Application) {
    this.app = app;
    this.db = app.db;
    this.cache = app.cache;
    this.logger = app.logger;
  }

  /**
   * 获取用户状态缓存键
   */
  private getUserStatusCacheKey(userId: number): string {
    return `userStatus:${userId}`;
  }

  /**
   * 从缓存获取用户状态
   */
  private async getUserStatusFromCache(userId: number): Promise<UserStatusCache | null> {
    try {
      const cacheKey = this.getUserStatusCacheKey(userId);
      const cached = await this.cache.get(cacheKey);
      return cached ? (JSON.parse(cached as unknown as string) as UserStatusCache) : null;
    } catch (error) {
      this.logger.error('Error getting user status from cache:', error);
      return null;
    }
  }

  /**
   * 设置用户状态缓存
   */
  private async setUserStatusCache(userId: number, data: UserStatusCache): Promise<void> {
    try {
      const cacheKey = this.getUserStatusCacheKey(userId);
      await this.cache.set(cacheKey, JSON.stringify(data), 300 * 1000); // 5分钟过期
    } catch (error) {
      this.logger.error('Error setting user status cache:', error);
    }
  }

  /**
   * 清除用户状态缓存
   */
  private async clearUserStatusCache(userId: number): Promise<void> {
    try {
      const cacheKey = this.getUserStatusCacheKey(userId);
      await this.cache.del(cacheKey);
    } catch (error) {
      this.logger.error('Error clearing user status cache:', error);
    }
  }

  /**
   * 检查用户状态是否允许登录
   * @param userId 用户ID
   * @returns 检查结果
   */
  async checkUserStatus(userId: number): Promise<UserStatusCheckResult> {
    try {
      // 步骤1: 尝试从缓存获取
      let cached = await this.getUserStatusFromCache(userId);

      // 步骤2: 缓存不存在,从数据库查询
      if (!cached) {
        const userRepo = this.db.getRepository('users');
        const user = await userRepo.findOne({
          filterByTk: userId,
          fields: ['id', 'status', 'statusExpireAt', 'previousStatus'],
        });

        if (!user) {
          return {
            allowed: false,
            status: 'unknown',
            errorMessage: this.app.i18n.t('User not found'),
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
        const userRepo = this.db.getRepository('users');
        const user = await userRepo.findOne({
          filterByTk: userId,
          fields: ['status'],
        });

        cached.status = user.status || 'active';
        cached.expireAt = null;
        cached.previousStatus = null;

        // 更新缓存
        await this.setUserStatusCache(userId, cached);
      }

      // 步骤4: 查询状态定义
      const statusRepo = this.db.getRepository('userStatuses');
      const statusInfo = await statusRepo.findOne({
        filterByTk: cached.status,
      });

      if (!statusInfo) {
        this.logger.warn(`Status definition not found: ${cached.status}`);
        // 状态定义不存在,阻止登录(状态异常)
        return {
          allowed: false,
          status: cached.status,
          statusInfo: {
            title: this.app.i18n.t('Invalid status', { ns: namespace }),
            color: 'red',
            allowLogin: false,
            loginErrorMessage: this.app.i18n.t('User status is invalid, please contact administrator', {
              ns: namespace,
            }),
          },
          errorMessage: this.app.i18n.t('User status is invalid, please contact administrator', { ns: namespace }),
        };
      }

      // 步骤5: 翻译 title 和 loginErrorMessage
      // 数据库中存储的是 {{t("...")}} 格式，需要解析并翻译
      const translateMessage = (message: string): string => {
        if (!message) return '';

        // 匹配 {{t("...")}} 格式
        const match = message.match(/\{\{t\("([^"]+)"\)\}\}/);
        if (match && match[1]) {
          return this.app.i18n.t(match[1], { ns: namespace });
        }

        // 如果不是模板格式，直接返回
        return message;
      };

      const translatedTitle = translateMessage(statusInfo.title);
      const translatedLoginErrorMessage = translateMessage(statusInfo.loginErrorMessage);

      // 步骤6: 返回检查结果
      return {
        allowed: statusInfo.allowLogin,
        status: cached.status,
        statusInfo: {
          title: translatedTitle,
          color: statusInfo.color,
          allowLogin: statusInfo.allowLogin,
          loginErrorMessage: translatedLoginErrorMessage,
        },
        errorMessage: !statusInfo.allowLogin
          ? translatedLoginErrorMessage || this.app.i18n.t('User status does not allow login', { ns: namespace })
          : undefined,
      };
    } catch (error) {
      this.logger.error(`Error checking user status for userId=${userId}: ${error}`);
      // 安全起见, 发生错误时阻止登录
      return {
        allowed: false,
        status: 'unknown',
        statusInfo: {
          title: this.app.i18n.t('Unknown status', { ns: namespace }),
          color: 'red',
          allowLogin: false,
          loginErrorMessage: this.app.i18n.t('System error, please contact administrator', { ns: namespace }),
        },
        errorMessage: this.app.i18n.t('System error, please contact administrator', { ns: namespace }),
      };
    }
  }

  /**
   * 修改用户状态
   * @param userId 用户ID
   * @param newStatus 新状态
   * @param options 选项
   */
  async changeUserStatus(userId: number, newStatus: string, options: ChangeUserStatusOptions): Promise<void> {
    const { expireAt, reason, operationType, operatorId } = options;

    try {
      // 步骤1: 查询当前用户状态
      const userRepo = this.db.getRepository('users');
      const user = await userRepo.findOne({
        filterByTk: userId,
        fields: ['id', 'status', 'statusExpireAt', 'previousStatus'],
      });

      if (!user) {
        throw new Error(this.app.i18n.t('User not found'));
      }

      const oldStatus = user.status || 'active';

      // 步骤2: 验证新状态是否存在
      const statusRepo = this.db.getRepository('userStatuses');
      const statusExists = await statusRepo.findOne({
        filterByTk: newStatus,
      });

      if (!statusExists) {
        throw new Error(this.app.i18n.t('Invalid user status'));
      }

      // 步骤3: 开启数据库事务
      await this.db.sequelize.transaction(async (transaction) => {
        // 更新 users 表
        await userRepo.update({
          filterByTk: userId,
          values: {
            status: newStatus,
            statusExpireAt: expireAt || null,
            previousStatus: oldStatus, // 保存当前状态用于恢复
            statusReason: reason || null,
          },
          transaction,
        });

        // 插入历史记录
        const historyRepo = this.db.getRepository('userStatusHistories');
        await historyRepo.create({
          values: {
            userId: userId,
            fromStatus: oldStatus,
            toStatus: newStatus,
            reason: reason || null,
            expireAt: expireAt || null,
            operationType: operationType,
            createdBy: operatorId || null,
          },
          transaction,
        });
      });

      // 步骤4: 清除缓存
      await this.clearUserStatusCache(userId);

      // 步骤5: 触发事件
      this.app.emitAsync('user:statusChanged', {
        userId,
        fromStatus: oldStatus,
        toStatus: newStatus,
        reason,
        operationType,
      });

      // 步骤6: 记录日志
      this.logger.info(`User status changed: userId=${userId}, ${oldStatus} → ${newStatus}, type=${operationType}`);
    } catch (error) {
      this.logger.error('Error changing user status:', error);
      throw error;
    }
  }

  /**
   * 恢复过期的用户状态
   * @param userId 用户ID
   */
  async restoreUserStatus(userId: number): Promise<void> {
    try {
      // 步骤1: 查询用户信息
      const userRepo = this.db.getRepository('users');
      const user = await userRepo.findOne({
        filterByTk: userId,
        fields: ['id', 'status', 'statusExpireAt', 'previousStatus'],
      });

      if (!user) {
        throw new Error(this.app.i18n.t('User not found'));
      }

      // 步骤2: 检查是否需要恢复
      if (!user.statusExpireAt || new Date(user.statusExpireAt) > new Date()) {
        // 未过期或没有设置过期时间
        return;
      }

      const oldStatus = user.status;
      const restoreToStatus = user.previousStatus || 'active'; // 默认恢复为 active

      // 步骤3: 开启事务执行恢复
      await this.db.sequelize.transaction(async (transaction) => {
        // 更新 users 表
        await userRepo.update({
          filterByTk: userId,
          values: {
            status: restoreToStatus,
            statusExpireAt: null,
            previousStatus: null,
            statusReason: this.app.i18n.t('Status expired, auto restored'),
          },
          transaction,
        });

        // 插入历史记录
        const historyRepo = this.db.getRepository('userStatusHistories');
        await historyRepo.create({
          values: {
            userId: userId,
            fromStatus: oldStatus,
            toStatus: restoreToStatus,
            reason: this.app.i18n.t('Status expired, auto restored'),
            operationType: 'auto',
            createdBy: null,
          },
          transaction,
        });
      });

      // 步骤4: 清除缓存
      await this.clearUserStatusCache(userId);

      // 步骤5: 触发事件
      this.app.emitAsync('user:statusRestored', {
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

  /**
   * 注册新的用户状态(供插件使用)
   * @param config 状态配置
   */
  async registerStatus(config: StatusConfig): Promise<void> {
    try {
      const statusRepo = this.db.getRepository('userStatuses');

      // 步骤1: 检查状态是否已存在
      const existing = await statusRepo.findOne({
        filterByTk: config.key,
      });

      if (existing) {
        // 如果是同一个插件,更新配置
        if (existing.packageName === config.packageName) {
          await statusRepo.update({
            filterByTk: config.key,
            values: {
              title: config.title,
              color: config.color || 'default',
              allowLogin: config.allowLogin,
              loginErrorMessage: config.loginErrorMessage || null,
              description: config.description || null,
              sort: config.sort || 0,
              config: config.config || {},
            },
          });
          this.logger.info(`Updated status: ${config.key} by ${config.packageName}`);
        } else {
          this.logger.warn(`Status ${config.key} already registered by ${existing.packageName}, skipping`);
        }
        return;
      }

      // 步骤2: 插入新状态
      await statusRepo.create({
        values: {
          key: config.key,
          title: config.title,
          color: config.color || 'default',
          allowLogin: config.allowLogin,
          loginErrorMessage: config.loginErrorMessage || null,
          isSystemDefined: false, // 插件注册的状态不是系统内置
          packageName: config.packageName,
          description: config.description || null,
          sort: config.sort || 0,
          config: config.config || {},
        },
      });

      this.logger.info(`Registered new status: ${config.key} by ${config.packageName}`);
    } catch (error) {
      this.logger.error('Error registering status:', error);
      throw error;
    }
  }

  /**
   * 批量修改用户状态
   * @param userIds 用户ID数组
   * @param newStatus 新状态
   * @param options 选项
   */
  async batchChangeUserStatus(
    userIds: number[],
    newStatus: string,
    options: ChangeUserStatusOptions,
  ): Promise<{ success: number[]; failed: number[] }> {
    const success: number[] = [];
    const failed: number[] = [];

    for (const userId of userIds) {
      try {
        await this.changeUserStatus(userId, newStatus, options);
        success.push(userId);
      } catch (error) {
        this.logger.error(`Failed to change status for user ${userId}:`, error);
        failed.push(userId);
      }
    }

    return { success, failed };
  }

  /**
   * 获取每个状态的用户数量统计
   */
  async getStatusStatistics(): Promise<Record<string, number>> {
    try {
      const userRepo = this.db.getRepository('users');
      const result = await userRepo.find({
        attributes: ['status', [this.db.sequelize.fn('COUNT', 'id'), 'count']],
        group: ['status'],
        raw: true,
      });

      const statistics: Record<string, number> = {};
      for (const row of result as any[]) {
        statistics[row.status] = parseInt(row.count, 10);
      }

      return statistics;
    } catch (error) {
      this.logger.error('Error getting status statistics:', error);
      return {};
    }
  }

  /**
   * 注入登录检查
   */
  injectLoginCheck() {
    // TODO: 主仓库可以发版后, 对 BaseAuth.signIn 的修改应该移动到主仓库中, 并在用户不可登录的错误中使用新的 AuthErrorCode
    const userStatusService = this; // 保存 UserStatusService 实例的引用

    BaseAuth.prototype.signIn = async function () {
      let user: Model;
      try {
        user = await this.validate();
      } catch (err) {
        this.ctx.throw(err.status || 401, err.message, {
          ...err,
        });
      }
      if (!user) {
        this.ctx.throw(401, {
          message: this.ctx.t('User not found. Please sign in again to continue.', { ns: namespace }),
          code: AuthErrorCode.NOT_EXIST_USER,
        });
      }

      // 使用 UserStatusService 检查用户状态是否允许登录
      const statusCheckResult: UserStatusCheckResult = await userStatusService.checkUserStatus(user.id);

      if (!statusCheckResult.allowed) {
        this.ctx.throw(403, {
          message: this.ctx.t(statusCheckResult.statusInfo.loginErrorMessage, { ns: namespace }),
          code: AuthErrorCode.INVALID_TOKEN,
        });
      }

      const token = await this.signNewToken(user.id);
      return {
        user,
        token,
      };
    };

    this.logger.info('signIn method injected with UserStatusService integration');
  }

  /**
   * 注册用户状态变更拦截器
   * 拦截 users:update 请求,自动记录状态变更历史
   */
  registerStatusChangeInterceptor() {
    const userStatusService = this;

    // 监听 users 表的更新操作
    this.db.on('users.beforeUpdate', async (model: any, options: any) => {
      // 检查是否有 status 字段变更
      if (model.changed('status')) {
        const oldStatus = model._previousDataValues.status || 'active';
        const newStatus = model.status;

        // 如果状态确实发生了变化
        if (oldStatus !== newStatus) {
          userStatusService.logger.info(`User status change detected: userId=${model.id}, ${oldStatus} → ${newStatus}`);

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
        }
      }
    });

    // 监听 users 表的更新完成
    this.db.on('users.afterUpdate', async (model: any, options: any) => {
      // 检查是否有状态变更记录
      const statusChange = options?.transaction?.__statusChange?.[model.id];

      if (statusChange) {
        try {
          // 获取当前操作用户ID
          const currentUserId = options?.context?.state?.currentUser?.id;

          // 记录状态变更历史
          const userStatusHistoriesRepo = userStatusService.db.getRepository('userStatusHistories');
          await userStatusHistoriesRepo.create({
            values: {
              userId: statusChange.userId,
              fromStatus: statusChange.fromStatus,
              toStatus: statusChange.toStatus,
              reason: statusChange.reason,
              expireAt: statusChange.expireAt,
              operationType: 'manual', // 通过 API 修改的都是手动操作
              createdById: currentUserId,
            },
            context: options.context,
          });

          userStatusService.logger.info(
            `User status history recorded: userId=${statusChange.userId}, ${statusChange.fromStatus} → ${statusChange.toStatus}`,
          );
        } catch (error) {
          userStatusService.logger.error('Failed to record user status history:', error);
        }

        // 清除用户状态缓存
        await userStatusService.clearUserStatusCache(statusChange.userId);
        userStatusService.logger.info(`User status cache cleared for userId=${statusChange.userId}`);
      }
    });

    this.logger.info('User status change interceptor registered');
  }
}

export default UserStatusService;
