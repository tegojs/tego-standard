import type { Application, Collection } from '@tego/server';

import _ from 'lodash';

import { SUMMARY_TYPE } from '../common/constants';
import { type ParamsType, type SummaryDataSourceItem } from '../common/interface';
import { isDateType } from '../common/utils';

async function parsePerson({ node, processor, keyName }) {
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

function getSummary(params: ParamsType): object {
  const { summaryConfig = [], data, collection, app } = params;

  const summaryDataSource = getSummaryDataSource({ summaryConfig, data, collection, app });

  return summaryDataSource;
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
    const uiSchema = (field as any).options?.uiSchema;
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

// 获取关联表
function getTargetCollection(mainKey: string, collection?: Collection, app?: Application): Collection | undefined {
  if (!collection) {
    return undefined;
  }

  const field = collection.getField(mainKey);
  if (!field || !field.target) {
    return undefined;
  }

  let targetCollection: Collection | undefined;

  // 服务器端的 collection 有 db 属性，可以直接获取关联表
  const db = (collection as any).db;
  if (db) {
    targetCollection = db.getCollection(field.target);
  } else if (app && app.dataSourceManager) {
    // 客户端或者没有 db 的情况，通过 app 获取
    const collectionDataSource = (collection as any).dataSource;
    let dataSource;
    if (collectionDataSource) {
      dataSource = app.dataSourceManager.dataSources.get(collectionDataSource);
    } else {
      // 默认使用 main dataSource
      dataSource = app.dataSourceManager.dataSources.get('main');
    }
    if (dataSource) {
      targetCollection = dataSource.collectionManager.getCollection(field.target);
    }
  }

  return targetCollection;
}

// 判断字段是否为多对多字段
function isManyToManyField(mainKey: string, collection?: Collection): boolean {
  if (!collection) {
    return false;
  }
  const field = collection.getField(mainKey);
  if (!field) {
    return false;
  }
  // 多对多字段类型：belongsToMany 或 hasMany
  return field.type === 'belongsToMany' || field.type === 'hasMany';
}

// 根据配置和源数据,生成符合类型要求的摘要数据
function getSummaryDataSource({ summaryConfig = [], data, collection, app }: ParamsType): SummaryDataSourceItem[] {
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
    const parentValue = _.get(data, mainKey);
    const label = getFieldLabel(mainKey, collection);

    // 判断是否为多对多字段
    const isManyToMany = isManyToManyField(mainKey, collection);

    if (isManyToMany && Array.isArray(parentValue) && parentValue.length > 0) {
      // 多对多字段：只展示 subPathKeys 里的从属字段
      // 直接基于 subPathKeys 处理，按字段名分组并找到最匹配的路径
      const mainKeyPrefix = `${mainKey}.`;
      const relevantSubKeys = subPathKeys.filter((subKey) => subKey.startsWith(mainKeyPrefix));

      if (relevantSubKeys.length === 0) {
        // 如果没有相关的 subPathKeys，降级为普通数组
        summaryDataSource.push(getSummaryItem(mainKey, data, collection, app));
      } else {
        // 按字段名分组，找到每个字段最匹配的路径
        const fieldPathMap = new Map<string, string>();
        for (const subKey of relevantSubKeys) {
          const relativePath = subKey.slice(mainKeyPrefix.length);
          const fieldName = relativePath.split('.')[0];

          if (!fieldPathMap.has(fieldName)) {
            fieldPathMap.set(fieldName, relativePath);
          } else {
            // 如果已存在，选择更长的路径（更具体的路径）
            const existingPath = fieldPathMap.get(fieldName)!;
            if (relativePath.length > existingPath.length) {
              fieldPathMap.set(fieldName, relativePath);
            }
          }
        }

        const targetFields = Array.from(fieldPathMap.keys());
        const childValues: (string | number)[][] = [];
        let isValidTable = true;
        let rowCount = 0;

        // 遍历 subPathKeys 中的字段
        for (const fieldName of targetFields) {
          const relativePath = fieldPathMap.get(fieldName)!;
          const fullSubKey = `${mainKey}.${fieldName}`;
          const childArray: (string | number)[] = [];

          // 对于多对多字段，从数组的每个元素中获取子字段值
          for (let i = 0; i < parentValue.length; i++) {
            const item = parentValue[i];
            const childValue = _.get(item, relativePath);
            const processedValue = processValue(childValue, fullSubKey, collection, app);
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
          // 获取关联表，用于获取字段的 label
          const targetCollection = getTargetCollection(mainKey, collection, app);

          // 构建 TABLE 类型：value 是一个数组，每个元素是一个字段（SummaryDataSourceItem）
          const tableFields: SummaryDataSourceItem[] = targetFields.map((fieldName, idx) => {
            // 从关联表中获取字段的 label
            const childLabel = targetCollection ? getFieldLabel(fieldName, targetCollection) : fieldName;
            return {
              key: fieldName,
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
      }
    } else {
      summaryDataSource.push(getSummaryItem(mainKey, data, collection, app));
    }
  }

  return summaryDataSource;
}

export { getSummary, parsePerson };
