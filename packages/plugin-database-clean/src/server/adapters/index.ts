import { Application } from '@tego/server';

import { BaseDatabaseAdapter } from './base-adapter';
import { MysqlAdapter } from './mysql-adapter';
import { PostgresAdapter } from './postgres-adapter';
import { SqliteAdapter } from './sqlite-adapter';

// 支持的数据库方言列表
const SUPPORTED_DIALECTS = ['postgres', 'mysql', 'sqlite'] as const;
type SupportedDialect = (typeof SUPPORTED_DIALECTS)[number];

/**
 * 数据库适配器工厂
 * 根据数据库类型返回对应的适配器实例
 */
export class DatabaseAdapterFactory {
  private static adapters: Map<string, new (app: Application) => BaseDatabaseAdapter> = new Map([
    ['postgres', PostgresAdapter],
    ['mysql', MysqlAdapter],
    ['sqlite', SqliteAdapter],
  ]);

  /**
   * 获取当前数据库对应的适配器
   * @param app Application 实例
   * @returns 数据库适配器实例
   * @throws 如果数据库类型不支持
   */
  static getAdapter(app: Application): BaseDatabaseAdapter {
    const dialect = app.db.sequelize.getDialect();

    const AdapterClass = this.adapters.get(dialect);

    if (!AdapterClass) {
      const supported = Array.from(this.adapters.keys()).join(', ');
      throw new Error(
        `Database dialect "${dialect}" is not supported by database-clean plugin. ` +
          `Currently supported: ${supported}`,
      );
    }

    return new AdapterClass(app);
  }

  /**
   * 检查当前数据库是否支持
   * @param app Application 实例
   * @returns 是否支持
   */
  static isSupported(app: Application): boolean {
    const dialect = app.db.sequelize.getDialect();
    return this.adapters.has(dialect);
  }

  /**
   * 获取支持的数据库类型列表
   */
  static getSupportedDialects(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * 注册自定义适配器（用于扩展）
   * @param dialect 数据库方言
   * @param adapterClass 适配器类
   */
  static registerAdapter(dialect: string, adapterClass: new (app: Application) => BaseDatabaseAdapter): void {
    this.adapters.set(dialect, adapterClass);
  }
}

// 导出所有适配器相关类型和类
export * from './base-adapter';
export * from './mysql-adapter';
export * from './postgres-adapter';
export * from './sqlite-adapter';
