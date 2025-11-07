import type { Application, Collection } from '@tego/server';

import { SUMMARY_TYPE } from './constants';

type SummaryValue = string | number | boolean | null | undefined;

export type SummaryType = (typeof SUMMARY_TYPE)[keyof typeof SUMMARY_TYPE];

export interface SummaryDataSourceItem {
  key: string;
  label: string;
  type: SummaryType;
  /**
   * 字段值，支持以下格式：
   * 1. 字符串：单个值（用于 STRING 类型）
   * 2. SummaryDataSourceItem[]：子字段数组（用于 ARRAY 类型，定义表格列）
   *    - 单行数据：每个子字段的 value 是单个字符串
   *    - 多行数据：每个子字段的 value 是字符串数组，数组长度必须一致
   *      例如：
   *      [
   *        { key: 'kemu', label: '科目', value: ['语文', '数学'] as any },
   *        { key: 'amount', label: '金额', value: ['100', '200'] as any }
   *      ]
   *      会渲染成 2 行数据
   *
   * 注意：多行数据时，value 需要使用类型断言，因为类型系统不支持递归的字符串数组
   */
  value: SummaryValue | Array<SummaryValue> | Array<SummaryDataSourceItem>;
}

export interface ParamsType {
  summaryConfig: Array<string>;
  data: object;
  collection?: Collection;
  app?: Application;
}
