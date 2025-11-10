import { useCollectionManager, useCollectionRecordData, useCompile, useOptimizedMemo } from '@tachybase/client';
import { convertUTCToLocal } from '@tego/client';

import { SUMMARY_TYPE } from '../../../../../common/constants';
import { type SummaryDataSourceItem } from '../../../../../common/interface';
import { isUTCString } from '../../../../../common/utils';
import { SimpleTable } from '../../../../common/components/SimpleTable';
import useStyles from '../style';

export const ApprovalsSummary = (props) => {
  const { value } = props;
  const isArrayValue = Array.isArray(value);

  // 兼容旧版, 旧版源数据是对象,新版源数据必然是数组
  return isArrayValue ? <SummaryShowArray arrayValue={value} /> : <SummaryShowObject objectValue={value} />;
};

// Used for compatibility with older versions, where the original data source is an object
const SummaryShowObject = (props) => {
  const cm = useCollectionManager();
  const compile = useCompile();
  const { styles } = useStyles();

  const { objectValue = {} } = props;

  const record = useCollectionRecordData();
  const { collectionName } = record;

  const results = useOptimizedMemo(() => {
    return Object.entries(objectValue).map(([key, objValue]) => {
      const field = cm.getCollectionField(`${collectionName}.${key}`);
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
    <div className={styles.ApprovalsSummaryStyle}>
      {results.map((item) => (
        <SummaryLiteralShow key={item.label} label={item.label} value={item.value} />
      ))}
    </div>
  );
};

const SummaryShowArray = (props) => {
  const { arrayValue = [] as SummaryDataSourceItem[] | object } = props;

  // 使用优化的 useMemo：先引用比较，再深度比较
  const renderedItems = useOptimizedMemo(() => {
    return arrayValue.map((item) => {
      const { key, type, label, value } = item || {};
      switch (type) {
        case SUMMARY_TYPE.LITERAL:
          return <SummaryLiteralShow key={key} label={label} value={value} />;
        case SUMMARY_TYPE.DATE:
          const isUTCStringValue = isUTCString(value);
          return (
            <SummaryLiteralShow key={key} label={label} value={isUTCStringValue ? convertUTCToLocal(value) : value} />
          );
        case SUMMARY_TYPE.TABLE:
          return <SummaryTableShow key={key} title={label} dataSource={value} />;
        default:
          return null;
      }
    });
  }, [arrayValue]);

  return renderedItems;
};

const SummaryLiteralShow = (props) => {
  const { label, value } = props;
  const { styles } = useStyles();
  return (
    <div className={`${styles.ApprovalsSummaryStyle}-item`}>
      <div className={`${styles.ApprovalsSummaryStyle}-item-label`}>{`${label}:`}&nbsp;&nbsp;&nbsp;</div>
      <div className={`${styles.ApprovalsSummaryStyle}-item-value`}>{value}</div>
    </div>
  );
};

const SummaryTableShow = (props) => {
  const { title, dataSource = [] as SummaryDataSourceItem[] } = props;

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
