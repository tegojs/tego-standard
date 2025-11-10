import { useCollectionManager, useCollectionRecordData, useCompile } from '@tachybase/client';
import { convertUTCToLocal } from '@tego/client';

import { SUMMARY_TYPE } from '../../../../../common/constants';
import { type SummaryDataSourceItem } from '../../../../../common/interface';
import { isUTCString } from '../../../../../common/utils';
import { SimpleTable } from '../../../../common/components/SimpleTable';
import useStyles from '../style';

const summaryDataSource: SummaryDataSourceItem[] = [
  {
    key: 'reason',
    label: '原因',
    type: SUMMARY_TYPE.LITERAL,
    value: '汇款回单收费及手续费账户扣款21笔计109.8',
  },
  {
    key: 'createdAt',
    label: '创建时间',
    type: SUMMARY_TYPE.DATE,
    value: '2025-10-25T01:06:02.698Z',
  },
  {
    key: 'company_pay',
    label: '付款公司',
    type: SUMMARY_TYPE.LITERAL,
    value: '北京某某有限公司',
  },
  {
    key: 'company_receive',
    label: '收款公司',
    type: SUMMARY_TYPE.LITERAL,
    value: '中国某某银行股份有限公司',
  },
  {
    key: 'items_amount_pay',
    label: '付款金额',
    type: SUMMARY_TYPE.LITERAL,
    value: 109.8,
  },
  {
    key: 'items_amount_receive',
    label: '收款金额',
    type: SUMMARY_TYPE.LITERAL,
    value: 109.8,
  },
  {
    key: 'items_amount_pay',
    label: '付款金额',
    type: SUMMARY_TYPE.LITERAL,
    value: 109.8,
  },
  {
    key: 'multiDetail',
    label: '明细',
    type: SUMMARY_TYPE.TABLE,
    value: [
      {
        key: 'kemu',
        label: '科目',
        type: SUMMARY_TYPE.ARRAY,
        // 多行数据：value 是数组，每个元素对应一行
        // 注意：需要使用类型断言，因为类型系统不支持递归的字符串数组
        value: ['租金', '利息', '办公费'] as any,
      },
      {
        key: 'amount',
        label: '金额',
        type: SUMMARY_TYPE.ARRAY,
        // 多行数据：value 是数组，每个元素对应一行
        // 注意：需要使用类型断言，因为类型系统不支持递归的字符串数组
        value: ['100', '200', '150'] as any,
      },
      {
        key: 'beizhu',
        label: '备注',
        type: SUMMARY_TYPE.ARRAY,
        // 多行数据：value 是数组，每个元素对应一行
        // 注意：需要使用类型断言，因为类型系统不支持递归的字符串数组
        value: ['备注1', '备注2', '备注3'] as any,
      },
    ],
  },
];

const SummaryArrayShow = (props) => {
  const { value = [] as SummaryDataSourceItem[] | object } = props;
  const { styles } = useStyles();

  return summaryDataSource.map((item) => {
    if (Array.isArray(item.value)) {
      /**
       * item.value 是字段定义数组，每个元素有 key, label, value
       *
       * 数据格式说明：
       * 1. 单行数据格式：
       *    [
       *      { key: 'kemu', label: '科目', value: '语文' },
       *      { key: 'amount', label: '金额', value: '100' }
       *    ]
       *
       * 2. 多行数据格式（每个字段的 value 是数组，数组长度必须一致）：
       *    [
       *      { key: 'kemu', label: '科目', value: ['语文', '数学', '英语'] },
       *      { key: 'amount', label: '金额', value: ['100', '200', '150'] }
       *    ]
       *    会渲染成 3 行数据
       */
      const fields = item.value as SummaryDataSourceItem[];
      // 检查第一个字段的 value 是否是数组（多行数据）还是单个值（单行数据）
      const firstValue = fields[0]?.value;
      // 判断是否为多行：value 是数组，且第一个元素是字符串（不是 SummaryDataSourceItem）
      const isMultiRow = Array.isArray(firstValue) && firstValue.length > 0 && typeof firstValue[0] === 'string';

      // 构建表格列配置
      const columns = fields.map((field) => ({
        key: field.key,
        title: field.label,
        dataIndex: field.key,
      }));

      if (isMultiRow) {
        // 多行数据：每个字段的 value 是一个数组
        const rowCount = Array.isArray(firstValue) ? firstValue.length : 0;
        const dataSource = Array.from({ length: rowCount }, (_, rowIdx) => {
          const record: Record<string, any> = {};
          fields.forEach((field) => {
            const fieldValue = Array.isArray(field.value) ? field.value[rowIdx] : field.value;
            record[field.key] = typeof fieldValue === 'string' ? fieldValue : String(fieldValue ?? '');
          });
          return record;
        });

        return <SimpleTable key={item.label} title={item.label} columns={columns} dataSource={dataSource} />;
      } else {
        // 单行数据：每个字段的 value 是单个值
        const dataSource = [
          fields.reduce(
            (acc, field) => {
              acc[field.key] = typeof field.value === 'string' ? field.value : String(field.value ?? '');
              return acc;
            },
            {} as Record<string, any>,
          ),
        ];

        return <SimpleTable key={item.label} title={item.label} columns={columns} dataSource={dataSource} />;
      }
    } else {
      return (
        <div className={`${styles.ApprovalsSummaryStyle}-item`} key={item.label}>
          <div className={`${styles.ApprovalsSummaryStyle}-item-label`}>{`${item.label}:`}&nbsp;&nbsp;&nbsp;</div>
          <div className={`${styles.ApprovalsSummaryStyle}-item-value`}>{item.value}</div>
        </div>
      );
    }
  });
};

export const ApprovalsSummary = (props) => {
  const record = useCollectionRecordData();
  const cm = useCollectionManager();
  const compile = useCompile();
  const { styles } = useStyles();

  const { value = [] as SummaryDataSourceItem[] | object } = props;
  const isArrayValue = Array.isArray(summaryDataSource);

  const { collectionName } = record;

  const results = Object.entries(value).map(([key, objValue]) => {
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

  // 展示结果要展示一个数组对象, 是 label 和 value 的形式
  // label 放中文, value 放值
  // 兼容旧版, 旧版源数据是对象,新版源数据必然是数组
  return isArrayValue ? (
    <SummaryArrayShow value={value} />
  ) : (
    <div className={styles.ApprovalsSummaryStyle}>
      {results.map((item) => (
        <div className={`${styles.ApprovalsSummaryStyle}-item`} key={item.label}>
          <div className={`${styles.ApprovalsSummaryStyle}-item-label`}>{`${item.label}:`}&nbsp;&nbsp;&nbsp;</div>
          <div className={`${styles.ApprovalsSummaryStyle}-item-value`}>{item.value}</div>
        </div>
      ))}
    </div>
  );
};
