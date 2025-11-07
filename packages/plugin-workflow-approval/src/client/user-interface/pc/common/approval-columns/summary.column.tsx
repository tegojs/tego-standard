import { useCollectionManager, useCollectionRecordData, useCompile } from '@tachybase/client';
import { convertUTCToLocal } from '@tego/client';

import { SUMMARY_TYPE } from '../../../../../common/constants';
import { type SummaryDataSourceItem } from '../../../../../common/interface';
import { isUTCString } from '../../../../../common/utils';
import useStyles from '../style';

const demoValueList: SummaryDataSourceItem[] = [
  {
    key: 'name',
    label: 'Name',
    type: SUMMARY_TYPE.STRING,
    value: 'John Doe',
  },
  {
    key: 'age',
    label: 'Age',
    type: SUMMARY_TYPE.ARRAY,
    value: [
      {
        key: 'name',
        label: 'Name',
        type: SUMMARY_TYPE.STRING,
        value: 'John Doe',
      },
      {
        key: 'name',
        label: 'Name',
        type: SUMMARY_TYPE.STRING,
        value: 'John Doe',
      },
    ],
  },
];

export const ApprovalsSummary = (props) => {
  const record = useCollectionRecordData();
  const cm = useCollectionManager();
  const compile = useCompile();
  const { styles } = useStyles();

  const { value = [] as SummaryDataSourceItem[] | object } = props;
  console.log('%c Line:14 🥐 value', 'font-size:18px;color:#42b983;background:#f5ce50', value);
  const isArrayValue = Array.isArray(value);

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
  return isArrayValue ? null : (
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
