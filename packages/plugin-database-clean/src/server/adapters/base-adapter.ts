import { Application, Collection } from '@tego/server';

/**
 * 表大小信息
 */
export interface TableSizeInfo {
  /** 表+索引的总大小（字节） */
  totalSize: number;
}

/**
 * 时间范围信息
 */
export interface TimeRangeInfo {
  minCreatedAt: Date | null;
  maxCreatedAt: Date | null;
  maxUpdatedAt: Date | null;
}

/**
 * ID 范围信息
 */
export interface IdRangeInfo {
  minId: number | null;
  maxId: number | null;
}

/**
 * 数据库适配器基类
 * 定义了数据库清理插件需要的所有数据库特定操作
 */
export abstract class BaseDatabaseAdapter {
  constructor(protected app: Application) {}

  /**
   * 获取适配器支持的数据库方言
   */
  abstract get dialect(): string;

  /**
   * 获取表的总大小（包括索引）
   * @param collection 集合对象
   */
  abstract getTableSize(collection: Collection): Promise<TableSizeInfo>;

  /**
   * 获取表的行数
   * @param collection 集合对象
   */
  abstract getRowCount(collection: Collection): Promise<number>;

  /**
   * 获取表的时间范围
   * @param collection 集合对象
   * @param hasCreatedAt 是否有 createdAt 字段
   * @param hasUpdatedAt 是否有 updatedAt 字段
   */
  abstract getTimeRange(collection: Collection, hasCreatedAt: boolean, hasUpdatedAt: boolean): Promise<TimeRangeInfo>;

  /**
   * 获取表的 ID 范围
   * @param collection 集合对象
   */
  abstract getIdRange(collection: Collection): Promise<IdRangeInfo>;
}
