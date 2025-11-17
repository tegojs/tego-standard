import { useCollectionManager, useCompile, useOptimizedMemo } from '@tachybase/client';
import { convertUTCToLocal } from '@tego/client';

import { SUMMARY_TYPE } from '../../../../../common/constants';
import type { SummaryDataSourceItem } from '../../../../../common/interface';
import { isUTCString } from '../../../../../common/utils';
import { SimpleTable } from '../../../../common/components/SimpleTable';

import '../../style/style.css';

interface ApprovalsSummaryProps {
  value: any;
  collectionName?: string;
}

export const ApprovalsSummary = (props: ApprovalsSummaryProps) => {
  const { value, collectionName } = props;
  const isArrayValue = Array.isArray(value);

  // 兼容旧版, 旧版源数据是对象,新版源数据必然是数组
  return isArrayValue ? (
    <SummaryShowArray arrayValue={value} />
  ) : (
    <SummaryShowObject objectValue={value} collectionName={collectionName} />
  );
};

// Used for compatibility with older versions, where the original data source is an object
interface SummaryShowObjectProps {
  objectValue?: Record<string, any>;
  collectionName?: string;
}

const SummaryShowObject = (props: SummaryShowObjectProps) => {
  const cm = useCollectionManager();
  const compile = useCompile();
  const { objectValue = {}, collectionName } = props;

  const results = useOptimizedMemo(() => {
    return Object.entries(objectValue).map(([key, objValue]) => {
      const field = collectionName ? cm.getCollectionField(`${collectionName}.${key}`) : null;
      const realValue = Object.prototype.toString.call(objValue) === '[object Object]' ? objValue?.['name'] : objValue;
      if (Array.isArray(realValue)) {
        return {
          label: compile(field?.uiSchema?.title || key),
          value: realValue.map((item) => item.value),
        };
      } else if (isUTCString(realValue)) {
        // 如果是UTC时间字符串, 则转换为本地时区时间
        return {
          label: compile(field?.uiSchema?.title || key),
          value: convertUTCToLocal(realValue),
        };
      }
      return {
        label: compile(field?.uiSchema?.title || key),
        value: realValue,
      };
    });
  }, [objectValue, collectionName, cm, compile]);

  // 展示结果要展示一个数组对象, 是 label 和 value 的形式
  // label 放中文, value 放值
  return (
    <div className="approvalsSummaryStyle">
      {results.map((item, index) => (
        <SummaryLiteralShow key={index} label={item.label} value={item.value} />
      ))}
    </div>
  );
};

interface SummaryShowArrayProps {
  arrayValue?: SummaryDataSourceItem[] | any;
}

const SummaryShowArray = (props: SummaryShowArrayProps) => {
  const compile = useCompile();
  const { arrayValue = [] } = props;

  // 使用优化的 useMemo：先引用比较，再深度比较
  const renderedItems = useOptimizedMemo(() => {
    return arrayValue.map((item: SummaryDataSourceItem) => {
      const { key, type, label, value } = item || {};
      const labelTitle = compile(label) || key;
      switch (type) {
        case SUMMARY_TYPE.LITERAL:
          return <SummaryLiteralShow key={key} label={labelTitle} value={value as any} />;
        case SUMMARY_TYPE.DATE:
          const isUTCStringValue = typeof value === 'string' && isUTCString(value);
          return (
            <SummaryLiteralShow
              key={key}
              label={labelTitle}
              value={isUTCStringValue ? convertUTCToLocal(value) : (value as any)}
            />
          );
        case SUMMARY_TYPE.ARRAY:
          // 数组类型：将数组转换为逗号分隔的字符串
          const arrayValueStr = Array.isArray(value)
            ? value.map((v) => String(v ?? '')).join(', ')
            : String(value ?? '');
          return <SummaryLiteralShow key={key} label={labelTitle} value={arrayValueStr} />;
        case SUMMARY_TYPE.TABLE:
          return <SummaryTableShow key={key} title={labelTitle} dataSource={value as SummaryDataSourceItem[]} />;
        default:
          return null;
      }
    });
  }, [arrayValue, compile]);

  return <>{renderedItems}</>;
};

interface SummaryLiteralShowProps {
  label: string | React.ReactNode;
  value: any;
}

const SummaryLiteralShow = (props: SummaryLiteralShowProps) => {
  const { label, value } = props;
  const compile = useCompile();
  return (
    <div className="approvalsSummaryStyle-item">
      <div className="approvalsSummaryStyle-label">{`${compile(label)}:`}&nbsp;&nbsp;</div>
      <div className="approvalsSummaryStyle-value">{value}</div>
    </div>
  );
};

interface SummaryTableShowProps {
  title?: React.ReactNode;
  dataSource?: SummaryDataSourceItem[];
}

const SummaryTableShow = (props: SummaryTableShowProps) => {
  const { title, dataSource = [] } = props;

  // 获取第一行数据, 决定有多少行数据
  const firstValue = dataSource[0]?.value;

  const columns = useOptimizedMemo(() => {
    return dataSource.map((field) => ({
      key: field.key,
      title: field.label,
      dataIndex: field.key,
    }));
  }, [dataSource]);

  const rowCount = Array.isArray(firstValue) ? firstValue.length : 0;

  const tableDataSource = useOptimizedMemo(() => {
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
};
