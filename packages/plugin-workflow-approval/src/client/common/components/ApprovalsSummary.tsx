import React, { useCallback, useMemo } from 'react';
import { useCollectionManager, useCompile, useOptimizedMemo } from '@tachybase/client';
import { convertUTCToLocal } from '@tego/client';

import { SUMMARY_TYPE } from '../../../common/constants';
import type { SummaryDataSourceItem } from '../../../common/interface';
import { isUTCString } from '../../../common/utils';
import { SimpleTable } from './SimpleTable';

// 常量提取，避免重复创建
const OBJECT_STRING = '[object Object]';
const DEFAULT_ITEM_CLASS = 'approvalsSummaryStyle-item';
const DEFAULT_LABEL_CLASS = 'approvalsSummaryStyle-label';
const DEFAULT_VALUE_CLASS = 'approvalsSummaryStyle-value';

interface ApprovalsSummaryProps {
  value: any;
  collectionName?: string;
  className?: string;
  itemClassName?: string;
  labelClassName?: string;
  valueClassName?: string;
}

export const ApprovalsSummary = React.memo<ApprovalsSummaryProps>((props) => {
  const { value, collectionName, className, itemClassName, labelClassName, valueClassName } = props;

  // Array.isArray 是 O(1) 操作，直接判断即可，useMemo 开销可能大于收益
  const isArrayValue = Array.isArray(value);

  // 兼容旧版, 旧版源数据是对象,新版源数据必然是数组
  return isArrayValue ? (
    <SummaryShowArray
      arrayValue={value}
      className={className}
      itemClassName={itemClassName}
      labelClassName={labelClassName}
      valueClassName={valueClassName}
    />
  ) : (
    <SummaryShowObject
      objectValue={value}
      collectionName={collectionName}
      className={className}
      itemClassName={itemClassName}
      labelClassName={labelClassName}
      valueClassName={valueClassName}
    />
  );
});

ApprovalsSummary.displayName = 'ApprovalsSummary';

// Used for compatibility with older versions, where the original data source is an object
interface SummaryShowObjectProps {
  objectValue?: Record<string, any>;
  collectionName?: string;
  className?: string;
  itemClassName?: string;
  labelClassName?: string;
  valueClassName?: string;
}

const SummaryShowObject = React.memo<SummaryShowObjectProps>((props) => {
  const cm = useCollectionManager();
  const compile = useCompile();
  const { objectValue = {}, collectionName, className, itemClassName, labelClassName, valueClassName } = props;

  // 使用 useCallback 缓存字段获取函数，避免每次重新创建
  const getField = useCallback(
    (key: string) => {
      return collectionName ? cm.getCollectionField(`${collectionName}.${key}`) : null;
    },
    [collectionName, cm],
  );

  const results = useOptimizedMemo(() => {
    return Object.entries(objectValue).map(([key, objValue]) => {
      const field = getField(key);
      // 使用常量替代字符串，避免重复创建
      const realValue = Object.prototype.toString.call(objValue) === OBJECT_STRING ? objValue?.['name'] : objValue;
      if (Array.isArray(realValue)) {
        return {
          key,
          label: compile(field?.uiSchema?.title || key),
          value: realValue.map((item) => item.value),
        };
      } else if (isUTCString(realValue)) {
        // 如果是UTC时间字符串, 则转换为本地时区时间
        return {
          key,
          label: compile(field?.uiSchema?.title || key),
          value: convertUTCToLocal(realValue),
        };
      }
      return {
        key,
        label: compile(field?.uiSchema?.title || key),
        value: realValue,
      };
    });
  }, [objectValue, getField, compile]);

  // 展示结果要展示一个数组对象, 是 label 和 value 的形式
  // label 放中文, value 放值
  return (
    <div className={className}>
      {results.map((item) => (
        <SummaryLiteralShow
          key={item.key}
          label={item.label}
          value={item.value}
          itemClassName={itemClassName}
          labelClassName={labelClassName}
          valueClassName={valueClassName}
        />
      ))}
    </div>
  );
});

SummaryShowObject.displayName = 'SummaryShowObject';

interface SummaryShowArrayProps {
  arrayValue?: SummaryDataSourceItem[] | any;
  className?: string;
  itemClassName?: string;
  labelClassName?: string;
  valueClassName?: string;
}

const SummaryShowArray = React.memo<SummaryShowArrayProps>((props) => {
  const compile = useCompile();
  const { arrayValue = [], itemClassName, labelClassName, valueClassName } = props;

  // 使用 useCallback 缓存数组转字符串的函数
  const arrayToString = useCallback((arr: any[]): string => {
    return arr.map((v) => String(v ?? '')).join(', ');
  }, []);

  // 使用优化的 useMemo：先引用比较，再深度比较
  const renderedItems = useOptimizedMemo(() => {
    return arrayValue.map((item: SummaryDataSourceItem) => {
      const { key, type, label, value } = item || {};
      const labelTitle = compile(label) || key;
      switch (type) {
        case SUMMARY_TYPE.LITERAL:
          return (
            <SummaryLiteralShow
              key={key}
              label={labelTitle}
              value={value as any}
              itemClassName={itemClassName}
              labelClassName={labelClassName}
              valueClassName={valueClassName}
            />
          );
        case SUMMARY_TYPE.DATE:
          const isUTCStringValue = typeof value === 'string' && isUTCString(value);
          return (
            <SummaryLiteralShow
              key={key}
              label={labelTitle}
              value={isUTCStringValue ? convertUTCToLocal(value) : (value as any)}
              itemClassName={itemClassName}
              labelClassName={labelClassName}
              valueClassName={valueClassName}
            />
          );
        case SUMMARY_TYPE.ARRAY:
          // 数组类型：将数组转换为逗号分隔的字符串
          const arrayValueStr = Array.isArray(value) ? arrayToString(value) : String(value ?? '');
          return (
            <SummaryLiteralShow
              key={key}
              label={labelTitle}
              value={arrayValueStr}
              itemClassName={itemClassName}
              labelClassName={labelClassName}
              valueClassName={valueClassName}
            />
          );
        case SUMMARY_TYPE.TABLE:
          return <SummaryTableShow key={key} title={labelTitle} dataSource={value as SummaryDataSourceItem[]} />;
        default:
          return null;
      }
    });
  }, [arrayValue, compile, itemClassName, labelClassName, valueClassName, arrayToString]);

  return <>{renderedItems}</>;
});

SummaryShowArray.displayName = 'SummaryShowArray';

interface SummaryLiteralShowProps {
  label: string | React.ReactNode;
  value: any;
  itemClassName?: string;
  labelClassName?: string;
  valueClassName?: string;
}

const SummaryLiteralShow = React.memo<SummaryLiteralShowProps>((props) => {
  const { label, value, itemClassName, labelClassName, valueClassName } = props;
  const compile = useCompile();

  // 使用 useMemo 缓存编译后的 label（compile 可能有开销）
  const compiledLabel = useMemo(() => compile(label), [label, compile]);
  // 简单的字符串默认值不需要 useMemo，直接计算即可（useMemo 开销可能大于收益）
  const defaultItemClassName = itemClassName || DEFAULT_ITEM_CLASS;
  const defaultLabelClassName = labelClassName || DEFAULT_LABEL_CLASS;
  const defaultValueClassName = valueClassName || DEFAULT_VALUE_CLASS;

  return (
    <div className={defaultItemClassName}>
      <div className={defaultLabelClassName}>{`${compiledLabel}:`}&nbsp;&nbsp;</div>
      <div className={defaultValueClassName}>{value}</div>
    </div>
  );
});

SummaryLiteralShow.displayName = 'SummaryLiteralShow';

interface SummaryTableShowProps {
  title?: React.ReactNode;
  dataSource?: SummaryDataSourceItem[];
}

const SummaryTableShow = React.memo<SummaryTableShowProps>((props) => {
  const { title, dataSource = [] } = props;

  // dataSource[0]?.value 是 O(1) 操作，useMemo 开销可能大于收益
  // 但考虑到 dataSource 可能是大数组，保留 useMemo 也可以
  const firstValue = useMemo(() => dataSource[0]?.value, [dataSource]);

  const columns = useOptimizedMemo(() => {
    return dataSource.map((field) => ({
      key: field.key,
      title: field.label,
      dataIndex: field.key,
    }));
  }, [dataSource]);

  // 使用 useMemo 缓存 rowCount 计算（依赖 firstValue，需要缓存）
  const rowCount = useMemo(() => (Array.isArray(firstValue) ? firstValue.length : 0), [firstValue]);

  const tableDataSource = useOptimizedMemo(() => {
    if (rowCount === 0) {
      return [];
    }
    // 预分配数组大小，避免动态扩容
    const result: Record<string, any>[] = new Array(rowCount);
    for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
      const record: Record<string, any> = {};
      // 使用 for 循环替代 forEach，性能更好
      for (let i = 0; i < dataSource.length; i++) {
        const field = dataSource[i];
        const fieldValue = Array.isArray(field.value) ? field.value[rowIdx] : field.value;
        record[field.key] = typeof fieldValue === 'string' ? fieldValue : String(fieldValue ?? '');
      }
      result[rowIdx] = record;
    }
    return result;
  }, [dataSource, rowCount]);

  return <SimpleTable title={title} columns={columns} dataSource={tableDataSource} />;
});

SummaryTableShow.displayName = 'SummaryTableShow';
