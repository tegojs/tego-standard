import _ from 'lodash';

import { type ParamsType, type SummaryDataSourceItem } from '../common/interface';

// summaryConfig = {
//   0: 'createdAt';
//   1: 'reason';
//   2: 'company_receive';
//   3: 'company_pay';
//   4: 'items_amount_pay';
//   5: 'accountItemList';
//   6: 'accountItemList.accounts';
//   7: 'createdBy';
// }

// 定义正则表达式, 检测形如 2024-07-04T04:46:27.166Z 的UTC时间字符串
const utcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 检测是否是UTC时间字符串
function isUTCString(str: string): boolean {
  return utcRegex.test(str);
}

// 检测是否是日期类型
function isDateType(value: any): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // 检查是否是UTC时间字符串
  if (isUTCString(value)) {
    return true;
  }
  // 检查是否是其他常见的日期格式
  const dateRegex = /^\d{4}-\d{2}-\d{2}/;
  if (dateRegex.test(value)) {
    // 尝试解析为日期，如果能解析且有效，则认为是日期
    const date = new Date(value);
    return !isNaN(date.getTime());
  }
  return false;
}

// 辅助函数，递归处理点号分割的 key
function getSummaryItem(key: string, data: object): SummaryDataSourceItem {
  const pathParts = key.split('.');
  let value: any = _.get(data, key);
  let type: 'string' | 'date' | 'array' = Array.isArray(value) ? 'array' : 'string';

  if (type === 'array') {
    // 遍历 value（数组），对每个元素递归处理余下 path
    const arr: SummaryDataSourceItem[] = [];
    // key like 'accountItemList.accounts'
    const parentKey = pathParts.slice(0, -1).join('.');
    const childKey = pathParts.slice(-1)[0];

    // 如果 parentKey 存在, 则找到 array: _.get(data, parentKey)
    // childKey 针对子元素
    let arrData: any[] = value;
    // 支持如 'accountItemList.accounts'
    if (parentKey && _.get(data, parentKey) && Array.isArray(_.get(data, parentKey))) {
      arrData = _.get(data, parentKey);
      type = 'array';
      arr.length = 0;
      for (const item of arrData) {
        const childVal = item[childKey];
        if (Array.isArray(childVal)) {
          // 例如 accountItemList.accounts: [{...}] 递归处理
          arr.push(
            ...childVal.map((child) => {
              const childStr = String(child);
              const childType = isDateType(childStr) ? 'date' : Array.isArray(child) ? 'array' : 'string';
              return {
                key,
                type: childType as 'string' | 'date' | 'array',
                value: Array.isArray(child)
                  ? child.map((x) => {
                      const xStr = String(x);
                      const xType = isDateType(xStr) ? 'date' : 'string';
                      return { key, type: xType as 'string' | 'date', value: xStr };
                    })
                  : childStr,
              };
            }),
          );
        } else {
          const childStr = String(childVal);
          const childType =
            typeof childVal === 'object' && Array.isArray(childVal)
              ? 'array'
              : isDateType(childStr)
                ? 'date'
                : 'string';
          arr.push({
            key: childKey,
            type: childType as 'string' | 'date' | 'array',
            value:
              typeof childVal === 'object' && Array.isArray(childVal)
                ? childVal.map((v) => {
                    const vStr = String(v);
                    const vType = isDateType(vStr) ? 'date' : 'string';
                    return { key: childKey, type: vType as 'string' | 'date', value: vStr };
                  })
                : childStr,
          });
        }
      }
    } else {
      // 普通的数组 value
      arr.push(
        ...value.map((item: any, idx: number) => {
          if (typeof item === 'object' && item !== null) {
            // 对象：返回 'name' 字段，如果有
            const itemValue = item.name !== undefined ? String(item.name) : JSON.stringify(item);
            const itemType = isDateType(itemValue) ? 'date' : 'string';
            return {
              key: `${key}[${idx}]`,
              type: itemType as 'string' | 'date',
              value: itemValue,
            };
          } else {
            const itemStr = String(item);
            const itemType = isDateType(itemStr) ? 'date' : 'string';
            return {
              key: `${key}[${idx}]`,
              type: itemType as 'string' | 'date',
              value: itemStr,
            };
          }
        }),
      );
    }
    return {
      key,
      type: 'array',
      value: arr,
    };
  } else {
    // string 或 date，对象处理：优先尝试取 name
    let valStr: string;
    if (value === undefined || value === null) {
      valStr = '';
    } else if (typeof value === 'object') {
      valStr = value.name !== undefined ? String(value.name) : JSON.stringify(value);
    } else {
      valStr = String(value);
    }
    // 判断是否是日期类型
    const finalType = isDateType(valStr) ? 'date' : 'string';
    return {
      key,
      type: finalType,
      value: valStr,
    };
  }
}

// 根据配置和源数据,生成符合类型要求的摘要数据
export function getSummaryDataSource({ summaryConfig = [], data }: ParamsType): SummaryDataSourceItem[] {
  // 识别父子关系的配置项
  const parentKeys = new Set<string>();
  const childKeys = new Map<string, string>(); // key: 子项key, value: 父项key

  // 找出所有父子关系
  for (const key of summaryConfig) {
    if (key.includes('.')) {
      // 找到可能的父项
      const parts = key.split('.');
      for (let i = 1; i < parts.length; i++) {
        const parentKey = parts.slice(0, i).join('.');
        if (summaryConfig.includes(parentKey)) {
          parentKeys.add(parentKey);
          childKeys.set(key, parentKey);
          break;
        }
      }
    }
  }

  // 针对每个 summaryConfig 的 key 生成数据源项
  const summaryDataSource: SummaryDataSourceItem[] = summaryConfig.map((key) => getSummaryItem(key, data));

  // 合并子项到父项
  for (const [childKey, parentKey] of childKeys.entries()) {
    const parentIndex = summaryDataSource.findIndex((item) => item.key === parentKey);
    const childIndex = summaryDataSource.findIndex((item) => item.key === childKey);

    if (parentIndex !== -1 && childIndex !== -1) {
      const parentItem = summaryDataSource[parentIndex];
      const childItem = summaryDataSource[childIndex];

      // 如果父项和子项都是数组类型，合并它们
      if (parentItem.type === 'array' && childItem.type === 'array') {
        const parentValue = Array.isArray(parentItem.value) ? parentItem.value : [];
        const childValue = Array.isArray(childItem.value) ? childItem.value : [];
        parentItem.value = [...parentValue, ...childValue];
      } else if (parentItem.type === 'array' && (childItem.type === 'string' || childItem.type === 'date')) {
        // 如果父项是数组，子项是字符串或日期，将子项添加到父项数组中
        const parentValue = Array.isArray(parentItem.value) ? parentItem.value : [];
        parentItem.value = [...parentValue, childItem];
      }
    }
  }

  // 过滤掉子项，只保留合并后的父项
  const childKeySet = new Set(childKeys.keys());
  return summaryDataSource.filter((item) => !childKeySet.has(item.key));
}

export function getSummary(params: ParamsType): object {
  const { summaryConfig = [], data } = params;

  const summaryDataSource = getSummaryDataSource({ summaryConfig, data });

  const result = summaryConfig.reduce((summary, key) => {
    const value = _.get(data, key);
    const realValue = Object.prototype.toString.call(value) === '[object Object]' ? value?.['name'] : value;
    return {
      ...summary,
      [key]: realValue,
    };
  }, {});

  return result;
}

export async function parsePerson({ node, processor, keyName }) {
  const configPerson = processor
    .getParsedValue(node.config?.[keyName] ?? [], node.id)
    .flat()
    .filter(Boolean);

  const targetPerson = new Set();
  const UserRepo = processor.options.plugin.app.db.getRepository('users');
  for (const item of configPerson) {
    if (typeof item === 'object') {
      const users = await UserRepo.find({
        ...item,
        fields: ['id'],
        transaction: processor.transaction,
      });
      users.forEach((userData) => targetPerson.add(userData.id));
    } else {
      targetPerson.add(item);
    }
  }
  return [...targetPerson];
}
