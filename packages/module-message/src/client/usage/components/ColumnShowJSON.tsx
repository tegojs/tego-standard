import React, { useMemo } from 'react';
import { useCollectionManager, useCollectionRecordData, useCompile } from '@tachybase/client';

import { TableOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

import { useTranslation } from '../../locale';
import { useStyles } from './ColumnShowJSON.style';

// 定义常量，避免重复创建
const OBJECT_STRING = '[object Object]';
const SUMMARY_TYPE = {
  LITERAL: 'literal', // 单个值
  TABLE: 'table', // 表格
  DATE: 'date', // 日期
  ARRAY: 'array', // 数组
};

// THINK: 可以改造后, 作为系统内置的展示此类 jsonb 数据的通用组件, 供其他地方使用
export const ColumnShowJSON = (props) => {
  const { value } = props;
  const record = useCollectionRecordData();
  const cm = useCollectionManager();
  const compile = useCompile();
  const { t } = useTranslation();
  const { styles } = useStyles();
  const { collectionName } = record;

  const results = useMemo(() => {
    // 兼容新版格式：数组格式
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }

          const { key, label, type, value: itemValue } = item || {};
          const labelTitle = compile(label) || key || '';

          let displayValue: string | number | null | undefined = '';
          let isTable = false;

          switch (type) {
            case SUMMARY_TYPE.LITERAL:
              // 如果是对象，尝试获取 name 属性，否则转换为字符串
              if (itemValue && Object.prototype.toString.call(itemValue) === OBJECT_STRING) {
                displayValue = itemValue?.name ?? JSON.stringify(itemValue);
              } else {
                displayValue = itemValue as string | number | null | undefined;
              }
              break;

            case SUMMARY_TYPE.DATE:
              if (itemValue) {
                const isUTCStringValue = typeof itemValue === 'string' && isUTCString(itemValue);
                displayValue = isUTCStringValue ? convertUTCToLocal(itemValue) : String(itemValue);
              }
              break;

            case SUMMARY_TYPE.ARRAY:
              // 数组类型：将数组转换为逗号分隔的字符串
              if (Array.isArray(itemValue)) {
                displayValue = itemValue
                  .map((v) => {
                    // 如果数组元素是对象，尝试获取 name 属性或转换为字符串
                    if (v && Object.prototype.toString.call(v) === OBJECT_STRING) {
                      return v?.name ?? JSON.stringify(v);
                    }
                    return String(v ?? '');
                  })
                  .join(', ');
              } else {
                displayValue = String(itemValue ?? '');
              }
              break;

            case SUMMARY_TYPE.TABLE:
              // 表格类型：简化显示，标记为表格类型以便特殊渲染
              displayValue = t('Table data');
              isTable = true;
              break;

            default:
              // 默认情况：如果是对象，尝试获取 name 属性或转换为字符串
              if (itemValue && Object.prototype.toString.call(itemValue) === OBJECT_STRING) {
                displayValue = itemValue?.name ?? JSON.stringify(itemValue);
              } else {
                displayValue = String(itemValue ?? '');
              }
              break;
          }

          return {
            key: key || labelTitle,
            label: labelTitle,
            value: displayValue,
            isTable,
          };
        })
        .filter(Boolean);
    }

    // 兼容旧版格式：对象格式
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).map(([key, objValue]) => {
        const field = cm.getCollectionField(`${collectionName}.${key}`);
        let realValue = objValue;

        // 如果是对象，尝试获取 name 属性
        if (Object.prototype.toString.call(objValue) === OBJECT_STRING) {
          realValue = objValue?.['name'] ?? objValue;
        }

        // 如果是数组，转换为逗号分隔的字符串
        if (Array.isArray(realValue)) {
          realValue = realValue
            .map((v) => {
              if (v && Object.prototype.toString.call(v) === OBJECT_STRING) {
                return v?.name ?? JSON.stringify(v);
              }
              return String(v ?? '');
            })
            .join(', ');
        }

        // 如果是对象（且没有 name 属性），转换为字符串
        if (realValue && Object.prototype.toString.call(realValue) === OBJECT_STRING) {
          realValue = JSON.stringify(realValue);
        }

        // 如果是UTC时间字符串, 则转换为本地时区时间
        if (typeof realValue === 'string' && isUTCString(realValue)) {
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
    }

    return [];
  }, [value, collectionName, cm, compile, t]);

  // 展示结果要展示一个数组对象, 是 label 和 value 的形式
  // label 放中文, value 放值
  return (
    <div className={styles.columnShowJSON}>
      {results.map((item) => (
        <div className="json-item" key={item.key || item.label}>
          <div className="item-label">{`${item.label}:`}&nbsp;&nbsp;&nbsp;</div>
          {item.isTable ? (
            <div className={`item-value ${styles.tablePlaceholder}`}>
              <TableOutlined style={{ marginRight: 4, fontSize: 12 }} />
              {item.value}
            </div>
          ) : (
            <div className="item-value">{item.value}</div>
          )}
        </div>
      ))}
    </div>
  );
};

// 定义正则表达式, 检测形如 2024-07-04T04:46:27.166Z 的UTC时间字符串
const utcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 测试函数
function isUTCString(str = '') {
  return utcRegex.test(str);
}

// 将UTC时间字符串转换为本地时区时间
function convertUTCToLocal(utcString) {
  // 使用dayjs解析UTC时间，并转换为本地时区时间
  const localDate = dayjs.utc(utcString).local().format('YYYY-MM-DD HH:mm:ss');
  return localDate;
}
