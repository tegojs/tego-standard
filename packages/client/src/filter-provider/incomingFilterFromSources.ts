import { mergeFilter } from './utils';

/** 与 FilterProvider.DataBlock 对齐，用于合并「谁连接了我」带来的 defaultFilter */
export type DataBlockIncomingRef = {
  uid: string;
  defaultFilter?: any;
  /** 本块在 schema 的 x-filter-targets 里声明的连接目标 uid 列表（发起方） */
  filterTargetUids?: string[];
};

/**
 * 被连接的数据卡片：将连接发起方数据卡片上的 defaultFilter（如设置数据范围）与自身 filter 做 $and。
 */
export function mergeIncomingFiltersFromSourceBlocks(
  ownFilter: unknown,
  currentBlockUid: string,
  dataBlocks: DataBlockIncomingRef[],
): any {
  if (!currentBlockUid) {
    return ownFilter ?? {};
  }
  const sources = dataBlocks.filter((b) => b.filterTargetUids?.length && b.filterTargetUids.includes(currentBlockUid));
  const sourceFilters = sources
    .map((b) => b.defaultFilter)
    .filter((f) => f && typeof f === 'object' && Object.keys(f).length > 0);
  if (!sourceFilters.length) {
    return ownFilter ?? {};
  }
  const own = ownFilter && typeof ownFilter === 'object' ? ownFilter : {};
  return mergeFilter([...sourceFilters, own], '$and');
}

/**
 * 带 x-filter-targets 的连接发起方（表格、筛选表单等）自身的 defaultFilter。
 */
export function getFilterSourceDefaultFilter(
  dataBlocks: DataBlockIncomingRef[],
  filterSourceUid: string | undefined,
): Record<string, any> {
  if (!filterSourceUid) {
    return {};
  }
  const f = dataBlocks.find((b) => b.uid === filterSourceUid)?.defaultFilter;
  if (f && typeof f === 'object' && Object.keys(f).length) {
    return f as Record<string, any>;
  }
  return {};
}
