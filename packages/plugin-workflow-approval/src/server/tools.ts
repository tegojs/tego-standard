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

function getValueType(value: any): SummaryType {
  if (Array.isArray(value)) {
    return SUMMARY_TYPE.ARRAY;
  }

  if (value instanceof Date || (typeof value.toDate === 'function' && value.toDate() instanceof Date)) {
    return SUMMARY_TYPE.DATE;
  }

  // 此时 value 可能是字面量,或者对象
  return SUMMARY_TYPE.LITERAL;
}

// 辅助函数，递归处理点号分割的 key
function getSummaryItem(key: string, data: object, collection?: Collection, app?: Application): SummaryDataSourceItem {
  const pathParts = key.split('.');
  let value: any = _.get(data, key);
  let type: SummaryType = getValueType(value);

  if (type === SUMMARY_TYPE.LITERAL) {
    // string 或 date，对象处理：优先尝试获取关联表的 titleField 值
    let valStr: string;
    if (value === undefined || value === null) {
      valStr = '';
    } else if (value instanceof Date || (typeof value.toDate === 'function' && value.toDate() instanceof Date)) {
      // 处理日期类型，转换为 UTC 类型的日期字符串
      const dateObj = value instanceof Date ? value : value.toDate();
      // 赋值
      valStr = dateObj.toISOString();
    } else if (typeof value === 'object') {
      // 获取 key 的第一部分（如果是嵌套路径，如 'foo.bar'，则取 'foo'）
      const fieldName = key.split('.')[0];
      const titleFieldValue = getAssociationTitleFieldValue(value, fieldName, collection, app);
      // 赋值
      valStr = titleFieldValue !== undefined ? titleFieldValue : value.name !== undefined ? String(value.name) : 'N/A';
    } else {
      valStr = String(value);
    }
    // 判断是否是日期类型
    const finalType = isDateType(valStr) ? SUMMARY_TYPE.DATE : SUMMARY_TYPE.LITERAL;
    return {
      key,
      label: key,
      type: finalType,
      value: valStr,
    };
  } else if (type === SUMMARY_TYPE.DATE) {
    return {
      key,
      label: key,
      type: SUMMARY_TYPE.DATE,
      value: value,
    };
  } else if (type === SUMMARY_TYPE.ARRAY) {
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
      type = SUMMARY_TYPE.ARRAY;
      arr.length = 0;
      for (const item of arrData) {
        const childVal = item[childKey];
        if (Array.isArray(childVal)) {
          // 例如 accountItemList.accounts: [{...}] 递归处理
          arr.push(
            ...childVal.map((child) => {
              const childStr = String(child);
              const childType = isDateType(childStr)
                ? SUMMARY_TYPE.DATE
                : Array.isArray(child)
                  ? SUMMARY_TYPE.ARRAY
                  : SUMMARY_TYPE.LITERAL;
              return {
                key,
                label: key,
                type: childType as SummaryType,
                value: Array.isArray(child)
                  ? child.map((x) => {
                      const xStr = String(x);
                      const xType = isDateType(xStr) ? SUMMARY_TYPE.DATE : SUMMARY_TYPE.LITERAL;
                      return {
                        key,
                        label: key,
                        type: xType as SummaryType,
                        value: xStr,
                      };
                    })
                  : childStr,
              };
            }),
          );
        } else {
          const childStr = String(childVal);
          const childType =
            typeof childVal === 'object' && Array.isArray(childVal)
              ? SUMMARY_TYPE.ARRAY
              : isDateType(childStr)
                ? SUMMARY_TYPE.DATE
                : SUMMARY_TYPE.LITERAL;
          arr.push({
            key: childKey,
            label: childKey,
            type: childType as SummaryType,
            value:
              typeof childVal === 'object' && Array.isArray(childVal)
                ? childVal.map((v) => {
                    const vStr = String(v);
                    const vType = isDateType(vStr) ? SUMMARY_TYPE.DATE : SUMMARY_TYPE.LITERAL;
                    return {
                      key: childKey,
                      label: childKey,
                      type: vType as SummaryType,
                      value: vStr,
                    };
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
            // 对象：优先尝试获取关联表的 titleField 值
            const titleFieldValue = getAssociationTitleFieldValue(item, key, collection, app);
            const itemValue =
              titleFieldValue !== undefined
                ? titleFieldValue
                : item.name !== undefined
                  ? String(item.name)
                  : JSON.stringify(item);
            const itemType = isDateType(itemValue) ? SUMMARY_TYPE.DATE : SUMMARY_TYPE.LITERAL;
            return {
              key: `${key}[${idx}]`,
              type: itemType as SummaryType,
              value: itemValue,
            };
          } else {
            const itemStr = String(item);
            const itemType = isDateType(itemStr) ? SUMMARY_TYPE.DATE : SUMMARY_TYPE.LITERAL;
            return {
              key: `${key}[${idx}]`,
              type: itemType as SummaryType,
              value: itemStr,
            };
          }
        }),
      );
    }
    return {
      key,
      label: key,
      type: SUMMARY_TYPE.ARRAY,
      value: arr,
    };
  }
}

// 根据配置和源数据,生成符合类型要求的摘要数据
export function getSummaryDataSource({
  summaryConfig = [],
  data,
  collection,
  app,
}: ParamsType): SummaryDataSourceItem[] {
  // 将 summaryConfig 分为遍历主路径（不含 '.' 的 key）和子路径（含 '.' 的 key）数组
  const mainPathKeys: string[] = [];
  const subPathKeys: string[] = [];

  for (const key of summaryConfig) {
    if (key.includes('.')) {
      subPathKeys.push(key);
    } else {
      mainPathKeys.push(key);
    }
  }

  // 针对 mainPathKeys 的每个 key，生成符合类型的摘要数据，如在 subPathKeys 存在它的子属性，则以子属性方式构建
  const summaryDataSource: SummaryDataSourceItem[] = [];

  for (const mainKey of mainPathKeys) {
    // 找到所有属于该主 key 的子属性，例如 mainKey = 'foo'，subPathKeys 里有 'foo.bar', 'foo.baz'
    const childrenSubKeys = subPathKeys
      .filter((subKey) => subKey.startsWith(mainKey + '.'))
      .map((subKey) => subKey.slice(mainKey.length + 1)); // 去掉 'foo.' 部分得到 'bar'、'baz'

    if (childrenSubKeys.length > 0) {
      // 构建子属性数据
      const parentValue = _.get(data, mainKey);
      // 对 parentValue 为数组的情况也做兼容
      let items: any[] = [];
      if (Array.isArray(parentValue)) {
        // 对于数组，对每一项构建相应的子属性对象
        items = parentValue.map((item) => {
          const childObj: Record<string, any> = {};
          for (const childKey of childrenSubKeys) {
            const value = _.get(item, childKey);
            // 优先取关联表的 titleField 值，否则取 name 字段，对象用 name, 其他直接取值
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const fullChildKey = `${mainKey}.${childKey}`;
              const fieldName = mainKey;
              const titleFieldValue = getAssociationTitleFieldValue(value, fieldName, collection, app);
              childObj[childKey] =
                titleFieldValue !== undefined ? titleFieldValue : value.name !== undefined ? value.name : value;
            } else {
              childObj[childKey] = value;
            }
          }
          return childObj;
        });
      } else if (parentValue && typeof parentValue === 'object') {
        // 单对象
        const childObj: Record<string, any> = {};
        for (const childKey of childrenSubKeys) {
          const value = _.get(parentValue, childKey);
          // 优先取关联表的 titleField 值，否则取 name 字段，对象用 name, 其他直接取值
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const fieldName = mainKey;
            const titleFieldValue = getAssociationTitleFieldValue(value, fieldName, collection, app);
            childObj[childKey] =
              titleFieldValue !== undefined ? titleFieldValue : value.name !== undefined ? value.name : value;
          } else {
            childObj[childKey] = value;
          }
        }
        items = [childObj];
      } else {
        // parentValue 不存在时
        items = [];
      }
      summaryDataSource.push({
        key: mainKey,
        label: mainKey,
        type: Array.isArray(parentValue) ? SUMMARY_TYPE.ARRAY : SUMMARY_TYPE.LITERAL,
        value: items,
      });
    } else {
      // 没有任何子属性，普通主属性
      summaryDataSource.push(getSummaryItem(mainKey, data, collection, app));
    }
  }

  return summaryDataSource;
}

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
