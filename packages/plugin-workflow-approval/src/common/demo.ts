import { SUMMARY_TYPE } from './constants';
import { SummaryDataSourceItem } from './interface';

export const summaryDataSource: SummaryDataSourceItem[] = [
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
