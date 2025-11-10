import type { Application, Collection } from '@tego/server';

import _ from 'lodash';

import { SUMMARY_TYPE } from '../common/constants';
import { type ParamsType, type SummaryDataSourceItem, type SummaryType } from '../common/interface';
import { isDateType } from '../common/utils';

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

export function getSummary(params: ParamsType): object {
  const { summaryConfig = [], data, collection, app } = params;

  const summaryDataSource = getSummaryDataSource({ summaryConfig, data, collection, app });

  const result = summaryConfig.reduce((summary, key) => {
    const value = _.get(data, key);
    let realValue = value;
    if (Object.prototype.toString.call(value) === '[object Object]' && !Array.isArray(value)) {
      // 优先获取关联表的 titleField 值
      const fieldName = key.split('.')[0];
      const titleFieldValue = getAssociationTitleFieldValue(value, fieldName, collection, app);
      realValue = titleFieldValue !== undefined ? titleFieldValue : value?.['name'];
    }
    return {
      ...summary,
      [key]: realValue,
    };
  }, {});

  return result;
}

// 获取关联表的 titleField 值
function getAssociationTitleFieldValue(
  value: any,
  fieldName: string,
  collection?: Collection,
  app?: Application,
): string | undefined {
  if ((!collection && !app) || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  // 如果没有传入 collection，但传入了 app，尝试从 fieldName 推断
  let field;
  let dataSource;
  let targetCollection;

  if (collection) {
    field = collection.getField(fieldName);
    if (!field || !field.target) {
      return undefined;
    }

    // 服务器端的 collection 有 db 属性，可以直接获取关联表
    const db = (collection as any).db;
    if (db) {
      targetCollection = db.getCollection(field.target);
    } else if (app && app.dataSourceManager) {
      // 客户端或者没有 db 的情况，通过 app 获取
      const collectionDataSource = (collection as any).dataSource;
      if (collectionDataSource) {
        dataSource = app.dataSourceManager.dataSources.get(collectionDataSource);
      } else {
        // 默认使用 main dataSource
        dataSource = app.dataSourceManager.dataSources.get('main');
      }
      if (dataSource) {
        targetCollection = dataSource.collectionManager.getCollection(field.target);
      }
    } else {
      // 客户端的情况，尝试从 collectionManager 获取
      try {
        const cm = (collection as any).collectionManager;
        if (cm) {
          dataSource = cm.dataSource;
          targetCollection = dataSource.collectionManager.getCollection(field.target);
        }
      } catch (e) {
        // 忽略错误
      }
    }
  } else if (app) {
    // 如果只有 app，无法直接获取 field 信息，返回 undefined
    return undefined;
  }
  if (!targetCollection) {
    return undefined;
  }

  // 获取关联表的 titleField
  const titleField = targetCollection.titleField || targetCollection.getPrimaryKey() || 'id';
  const titleValue = value[titleField];

  return titleValue !== undefined && titleValue !== null ? String(titleValue) : undefined;
}

// 获取字段的 label
function getFieldLabel(key: string, collection?: Collection): string {
  if (!collection) {
    return key;
  }
  const field = collection.getField(key);
  // 服务端可能没有 uiSchema，尝试获取 title 或其他属性
  if (field) {
    // 尝试从 uiSchema 获取 title
    const uiSchema = (field as any).uiSchema;
    if (uiSchema?.title) {
      return uiSchema.title;
    }
    // 尝试从其他属性获取
    if ((field as any).title) {
      return (field as any).title;
    }
  }
  return key;
}

// 处理单个值，返回字符串或数字
function processValue(value: any, fieldName: string, collection?: Collection, app?: Application): string | number {
  if (value === undefined || value === null) {
    return '';
  }

  if (value instanceof Date || (typeof value.toDate === 'function' && value.toDate() instanceof Date)) {
    // 处理日期类型，转换为 UTC 类型的日期字符串
    const dateObj = value instanceof Date ? value : value.toDate();
    return dateObj.toISOString();
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    // 对象：优先尝试获取关联表的 titleField 值
    const titleFieldValue = getAssociationTitleFieldValue(value, fieldName, collection, app);
    if (titleFieldValue !== undefined) {
      return titleFieldValue;
    }
    // 尝试获取 name 字段
    if (value.name !== undefined) {
      return String(value.name);
    }
    // 默认返回字符串化的对象
    return JSON.stringify(value);
  }

  // 数字类型直接返回
  if (typeof value === 'number') {
    return value;
  }

  return String(value);
}

// 辅助函数，处理单个字段
function getSummaryItem(key: string, data: object, collection?: Collection, app?: Application): SummaryDataSourceItem {
  const value: any = _.get(data, key);
  const label = getFieldLabel(key, collection);

  if (value === undefined || value === null) {
    return {
      key,
      label,
      type: SUMMARY_TYPE.LITERAL,
      value: '',
    };
  }

  // 判断类型
  if (Array.isArray(value)) {
    // 数组类型：处理数组中的每个元素
    const processedArray: (string | number)[] = [];
    for (const item of value) {
      const processedValue = processValue(item, key, collection, app);
      processedArray.push(processedValue);
    }
    return {
      key,
      label,
      type: SUMMARY_TYPE.ARRAY,
      value: processedArray,
    };
  }

  if (value instanceof Date || (typeof value.toDate === 'function' && value.toDate() instanceof Date)) {
    // 日期类型
    const dateObj = value instanceof Date ? value : value.toDate();
    return {
      key,
      label,
      type: SUMMARY_TYPE.DATE,
      value: dateObj.toISOString(),
    };
  }

  // 处理普通值
  const processedValue = processValue(value, key, collection, app);
  const valueStr = String(processedValue);
  const finalType = isDateType(valueStr) ? SUMMARY_TYPE.DATE : SUMMARY_TYPE.LITERAL;

  return {
    key,
    label,
    type: finalType,
    value: processedValue,
  };
}

// 根据配置和源数据,生成符合类型要求的摘要数据
export function getSummaryDataSource({
  summaryConfig = [],
  data,
  collection,
  app,
}: ParamsType): SummaryDataSourceItem[] {
  // 将 summaryConfig 分为主路径（不含 '.' 的 key）和子路径（含 '.' 的 key）数组
  const mainPathKeys: string[] = [];
  const subPathKeys: string[] = [];

  for (const key of summaryConfig) {
    if (key.includes('.')) {
      subPathKeys.push(key);
    } else {
      mainPathKeys.push(key);
    }
  }

  const summaryDataSource: SummaryDataSourceItem[] = [];

  for (const mainKey of mainPathKeys) {
    // 找到所有属于该主 key 的子属性，例如 mainKey = 'accountItemList'，subPathKeys 里有 'accountItemList.accounts', 'accountItemList.amount'
    const childrenSubKeys = subPathKeys
      .filter((subKey) => subKey.startsWith(mainKey + '.'))
      .map((subKey) => subKey.slice(mainKey.length + 1)); // 去掉 'accountItemList.' 部分得到 'accounts'、'amount'

    if (childrenSubKeys.length > 0) {
      // 有子属性，需要构建 TABLE 类型或嵌套结构
      const parentValue = _.get(data, mainKey);
      const label = getFieldLabel(mainKey, collection);

      if (Array.isArray(parentValue) && parentValue.length > 0) {
        // 数组类型：构建 TABLE 类型
        // 检查每个子字段的值是否都是数组，且长度相同
        const childValues: (string | number)[][] = [];
        let isValidTable = true;
        let rowCount = 0;

        for (const childKey of childrenSubKeys) {
          const childArray: (string | number)[] = [];
          for (const item of parentValue) {
            const childValue = _.get(item, childKey);
            const processedValue = processValue(childValue, `${mainKey}.${childKey}`, collection, app);
            childArray.push(processedValue);
          }
          childValues.push(childArray);

          // 检查数组长度
          if (rowCount === 0) {
            rowCount = childArray.length;
          } else if (rowCount !== childArray.length) {
            isValidTable = false;
          }
        }

        if (isValidTable && rowCount > 0) {
          // 构建 TABLE 类型：value 是一个数组，每个元素是一个字段（SummaryDataSourceItem）
          const tableFields: SummaryDataSourceItem[] = childrenSubKeys.map((childKey, idx) => {
            const fullChildKey = `${mainKey}.${childKey}`;
            const childLabel = getFieldLabel(fullChildKey, collection);
            return {
              key: childKey,
              label: childLabel,
              type: SUMMARY_TYPE.ARRAY,
              value: childValues[idx],
            };
          });

          summaryDataSource.push({
            key: mainKey,
            label,
            type: SUMMARY_TYPE.TABLE,
            value: tableFields,
          });
        } else {
          // 如果不符合 TABLE 格式，降级为普通数组
          summaryDataSource.push(getSummaryItem(mainKey, data, collection, app));
        }
      } else if (parentValue && typeof parentValue === 'object' && !Array.isArray(parentValue)) {
        // 单对象：构建嵌套对象结构
        const childObj: Record<string, any> = {};
        for (const childKey of childrenSubKeys) {
          const value = _.get(parentValue, childKey);
          childObj[childKey] = processValue(value, `${mainKey}.${childKey}`, collection, app);
        }
        summaryDataSource.push({
          key: mainKey,
          label,
          type: SUMMARY_TYPE.LITERAL,
          value: JSON.stringify(childObj),
        });
      } else {
        // parentValue 不存在或为空，返回空值
        summaryDataSource.push({
          key: mainKey,
          label,
          type: SUMMARY_TYPE.LITERAL,
          value: '',
        });
      }
    } else {
      // 没有任何子属性，普通主属性
      summaryDataSource.push(getSummaryItem(mainKey, data, collection, app));
    }
  }

  // 处理子路径中不属于任何主路径的项（这种情况不应该发生，但为了健壮性还是处理）
  for (const subKey of subPathKeys) {
    const mainKey = subKey.split('.')[0];
    if (!mainPathKeys.includes(mainKey)) {
      // 如果子路径的主路径不在 mainPathKeys 中，单独处理
      summaryDataSource.push(getSummaryItem(subKey, data, collection, app));
    }
  }

  return summaryDataSource;
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
