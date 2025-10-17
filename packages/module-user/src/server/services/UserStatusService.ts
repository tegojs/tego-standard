import { Application, Cache, Database } from '@tego/server';

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
      await this.cache.set(cacheKey, JSON.stringify(data), 300); // 5分钟过期
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
}

export default UserStatusService;
