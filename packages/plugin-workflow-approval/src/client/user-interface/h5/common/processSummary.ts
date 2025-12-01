import dayjs from 'dayjs';

import { SUMMARY_TYPE } from '../../../../common/constants';
import type { SummaryDataSourceItem } from '../../../../common/interface';

interface SummaryItem {
  label: string;
  value: string | number | null | undefined;
}

/**
 * 处理 summary 数据，兼容新旧两种格式
 * @param summary - 可能是旧格式的对象或新格式的数组
 * @param collectionName - 集合名称
 * @param cm - CollectionManager 实例
 * @param compile - 编译函数
 * @returns 统一格式的 summary 数组
 */
export function processSummary(
  summary: any,
  collectionName: string,
  cm: any,
  compile: (value: any) => string,
): SummaryItem[] {
  // 兼容旧版格式：对象格式
  if (!Array.isArray(summary) && typeof summary === 'object' && summary !== null) {
    const result: SummaryItem[] = [];
    Object.entries(summary).forEach(([key, value]) => {
      const field = cm.getCollectionField(`${collectionName}.${key}`);
      let resonValue = value;
      if (field?.type === 'date' && value) {
        resonValue = dayjs(value as string).format('YYYY-MM-DD HH:mm:ss');
      }
      const item: SummaryItem = {
        label: compile(field?.uiSchema?.title || key),
        value:
          (Object.prototype.toString.call(value) === '[object Object]' ? (resonValue as any)?.['name'] : resonValue) ||
          '',
      };
      if (key === 'createdAt') {
        result.unshift(item);
      } else {
        result.push(item);
      }
    });
    return result;
  }

  // 新版格式：数组格式 SummaryDataSourceItem[]
  if (Array.isArray(summary)) {
    const result: SummaryItem[] = [];
    for (const item of summary as SummaryDataSourceItem[]) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const { key, label, type, value } = item;
      const labelTitle = compile(label) || key;

      let displayValue: string | number | null | undefined = '';

      switch (type) {
        case SUMMARY_TYPE.LITERAL:
          displayValue = value as string | number | null | undefined;
          break;

        case SUMMARY_TYPE.DATE:
          if (value) {
            displayValue = dayjs(value as string).format('YYYY-MM-DD HH:mm:ss');
          }
          break;

        case SUMMARY_TYPE.ARRAY:
          // 数组类型：将数组转换为逗号分隔的字符串
          if (Array.isArray(value)) {
            displayValue = value.map((v) => String(v ?? '')).join(', ');
          } else {
            displayValue = String(value ?? '');
          }
          break;

        case SUMMARY_TYPE.TABLE:
          // 表格类型：在 h5 中简化显示，显示为 "表格数据" 或显示第一行数据
          if (Array.isArray(value) && value.length > 0) {
            const firstRow = value[0];
            if (firstRow && typeof firstRow === 'object' && 'value' in firstRow) {
              // 如果有多个字段，显示第一个字段的值
              const firstFieldValue = Array.isArray(firstRow.value) ? firstRow.value[0] : firstRow.value;
              displayValue = String(firstFieldValue ?? '');
            } else {
              displayValue = '表格数据';
            }
          } else {
            displayValue = '表格数据';
          }
          break;

        default:
          displayValue = String(value ?? '');
          break;
      }

      const summaryItem: SummaryItem = {
        label: labelTitle,
        value: displayValue,
      };

      if (key === 'createdAt') {
        result.unshift(summaryItem);
      } else {
        result.push(summaryItem);
      }
    }
    return result;
  }

  return [];
}
