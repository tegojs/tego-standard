import React, { useMemo } from 'react';
import { useCollectionManager, useCompile, useOptimizedMemo } from '@tachybase/client';
import { convertUTCToLocal } from '@tego/client';

import { SUMMARY_TYPE } from '../../../common/constants';
import type { SummaryDataSourceItem } from '../../../common/interface';
import { isUTCString } from '../../../common/utils';
import { SimpleTable } from './SimpleTable';

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

  // 使用 useMemo 缓存判断结果
  const isArrayValue = useMemo(() => Array.isArray(value), [value]);

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

  const results = useOptimizedMemo(() => {
    return Object.entries(objectValue).map(([key, objValue]) => {
      const field = collectionName ? cm.getCollectionField(`${collectionName}.${key}`) : null;
      const realValue = Object.prototype.toString.call(objValue) === '[object Object]' ? objValue?.['name'] : objValue;
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
  }, [objectValue, collectionName, cm, compile]);

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
          const arrayValueStr = Array.isArray(value)
            ? value.map((v) => String(v ?? '')).join(', ')
            : String(value ?? '');
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
  }, [arrayValue, compile, itemClassName, labelClassName, valueClassName]);

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

  // 使用 useMemo 缓存编译后的 label 和类名
  const compiledLabel = useMemo(() => compile(label), [label, compile]);
  const defaultItemClassName = useMemo(() => itemClassName || 'approvalsSummaryStyle-item', [itemClassName]);
  const defaultLabelClassName = useMemo(() => labelClassName || 'approvalsSummaryStyle-label', [labelClassName]);
  const defaultValueClassName = useMemo(() => valueClassName || 'approvalsSummaryStyle-value', [valueClassName]);

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

  // 使用 useMemo 缓存第一行数据的获取
  const firstValue = useMemo(() => dataSource[0]?.value, [dataSource]);

  const columns = useOptimizedMemo(() => {
    return dataSource.map((field) => ({
      key: field.key,
      title: field.label,
      dataIndex: field.key,
    }));
  }, [dataSource]);

  // 使用 useMemo 缓存 rowCount 计算
  const rowCount = useMemo(() => (Array.isArray(firstValue) ? firstValue.length : 0), [firstValue]);

  const tableDataSource = useOptimizedMemo(() => {
    if (rowCount === 0) {
      return [];
    }
    return Array.from(
      {
        length: rowCount,
      },
      (_, rowIdx) => {
        const record: Record<string, any> = {};
        dataSource.forEach((field) => {
          const fieldValue = Array.isArray(field.value) ? field.value[rowIdx] : field.value;
          record[field.key] = typeof fieldValue === 'string' ? fieldValue : String(fieldValue ?? '');
        });
        return record;
      },
    );
  }, [dataSource, rowCount]);

  return <SimpleTable title={title} columns={columns} dataSource={tableDataSource} />;
});

SummaryTableShow.displayName = 'SummaryTableShow';
