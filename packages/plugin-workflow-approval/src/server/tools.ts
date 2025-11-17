import type { Application, Collection } from '@tego/server';

import _ from 'lodash';

import { SUMMARY_TYPE } from '../common/constants';
import { type ParamsType, type SummaryDataSourceItem } from '../common/interface';
import { isDateType } from '../common/utils';

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

// 判断字段是否为关联字段
function isAssociationField(field: any): boolean {
  if (!field || typeof field !== 'object') {
    return false;
  }
  const fieldType = field.type || (field as any).type;
  return ['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(fieldType);
}

// 判断字段是否为普通字段（非主键、非外键、非系统字段、非关联字段）
function isNormalField(field: any, fieldName: string, targetCollection?: Collection): boolean {
  // 系统字段名称
  const systemFieldNames = ['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];
  if (systemFieldNames.includes(fieldName)) {
    return false;
  }

  // 主键字段
  if (
    field?.primaryKey === true ||
    (typeof field === 'object' && field !== null && (field as any).primaryKey === true)
  ) {
    return false;
  }

  // 外键字段：检查 isForeignKey 属性
  if (
    field?.isForeignKey === true ||
    (typeof field === 'object' && field !== null && (field as any).isForeignKey === true)
  ) {
    return false;
  }

  // 外键字段：type 为 foreignKey
  if (
    field?.type === 'foreignKey' ||
    (typeof field === 'object' && field !== null && (field as any).type === 'foreignKey')
  ) {
    return false;
  }

  // 检查是否有其他字段的 foreignKey 属性指向这个字段名（说明这个字段是外键）
  if (targetCollection) {
    try {
      const allFields = (targetCollection as any).fields;
      if (allFields instanceof Map) {
        for (const [, otherField] of allFields) {
          if (otherField?.foreignKey === fieldName) {
            return false;
          }
        }
      } else if (Array.isArray(allFields)) {
        for (const otherField of allFields) {
          if (otherField?.foreignKey === fieldName) {
            return false;
          }
        }
      } else if (typeof allFields === 'object' && allFields !== null) {
        for (const otherField of Object.values(allFields)) {
          if ((otherField as any)?.foreignKey === fieldName) {
            return false;
          }
        }
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // 字段名以 Id 结尾的通常是外键（如 userId, categoryId 等）
  // 但排除系统字段（如 createdById, updatedById 已经在上面处理了）
  if (fieldName.endsWith('Id') && fieldName !== 'id') {
    return false;
  }

  // 关联字段
  if (isAssociationField(field)) {
    return false;
  }

  return true;
}

// 获取关联表的字段名（只展示普通字段，以及在 subPathKeys 里标明的关系字段）
function getTargetCollectionFields(
  mainKey: string,
  subPathKeys: string[],
  collection?: Collection,
  app?: Application,
): string[] {
  if (!collection) {
    return [];
  }

  const field = collection.getField(mainKey);
  if (!field || !field.target) {
    return [];
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

  if (!targetCollection) {
    return [];
  }

  // 获取目标表的所有字段
  // 服务器端的 collection.fields 是 Map，客户端可能是数组
  const fields = (targetCollection as any).fields;
  let fieldNames: string[] = [];
  let fieldMap: Map<string, any> | Record<string, any> | undefined;

  if (fields instanceof Map) {
    fieldMap = fields;
    fieldNames = Array.from(fields.keys());
  } else if (Array.isArray(fields)) {
    // 创建字段映射以便后续判断
    fieldMap = fields.reduce((acc: Record<string, any>, f: any) => {
      const name = f.name || f;
      acc[name] = f;
      return acc;
    }, {});
    fieldNames = fields.map((f: any) => f.name || f);
  } else if (typeof fields === 'object' && fields !== null) {
    fieldNames = Object.keys(fields);
    fieldMap = fields;
  } else {
    // 尝试使用 getFields 方法（可能是异步的，但这里先尝试同步调用）
    try {
      const fieldsList = (targetCollection as any).getFields?.();
      if (Array.isArray(fieldsList)) {
        fieldNames = fieldsList.map((f: any) => f.name || f);
        fieldMap = fieldsList.reduce((acc: Record<string, any>, f: any) => {
          const name = f.name || f;
          acc[name] = f;
          return acc;
        }, {});
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // 正向逻辑：只展示普通字段，以及在 subPathKeys 里标明的关系字段
  return fieldNames.filter((fieldName) => {
    let fieldObj: any;
    if (fieldMap instanceof Map) {
      fieldObj = fieldMap.get(fieldName);
    } else if (fieldMap && typeof fieldMap === 'object') {
      fieldObj = fieldMap[fieldName];
    } else {
      // 如果无法获取字段对象，尝试通过 getField 方法获取
      try {
        fieldObj = targetCollection?.getField(fieldName);
      } catch (e) {
        // 忽略错误
      }
    }

    // 1. 如果是普通字段，则包含
    if (isNormalField(fieldObj, fieldName, targetCollection)) {
      return true;
    }

    // 2. 如果是关联字段，检查 subPathKeys 中是否有对应的路径
    if (isAssociationField(fieldObj)) {
      const fullSubKey = `${mainKey}.${fieldName}`;
      // 检查是否有完全匹配或前缀匹配的路径
      const hasMatchingPath = subPathKeys.some((subKey) => {
        return subKey === fullSubKey || subKey.startsWith(fullSubKey + '.');
      });
      return hasMatchingPath;
    }

    // 其他情况不包含
    return false;
  });
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
      // 多对多字段：只展示普通字段，以及在 subPathKeys 里标明的关系字段
      const targetFields = getTargetCollectionFields(mainKey, subPathKeys, collection, app);
      const childValues: (string | number)[][] = [];
      let isValidTable = true;
      let rowCount = 0;

      // 遍历目标表的所有字段
      for (const fieldName of targetFields) {
        const fullSubKey = `${mainKey}.${fieldName}`;
        const relativeSubKey = fieldName;

        // 检查 subPathKeys 中是否有对应的路径（支持嵌套路径，如 'accountItemList.accounts.name'）
        const matchingSubKeys = subPathKeys.filter((subKey) => {
          if (subKey === fullSubKey) {
            return true;
          }
          // 支持嵌套路径，如 'accountItemList.accounts.name' 匹配 'accountItemList.accounts'
          return subKey.startsWith(fullSubKey + '.');
        });

        const childArray: (string | number)[] = [];

        // 对于多对多字段，从数组的每个元素中获取子字段值
        for (let i = 0; i < parentValue.length; i++) {
          const item = parentValue[i];
          let childValue;

          if (matchingSubKeys.length > 0) {
            // 如果 subPathKeys 中有对应的路径，使用最匹配的路径来获取值
            // 优先使用完全匹配的路径，否则使用最长的匹配路径
            const bestMatch = matchingSubKeys.reduce((best, current) => {
              if (current === fullSubKey) {
                return current;
              }
              if (!best || current.length > best.length) {
                return current;
              }
              return best;
            }, '');

            // 提取相对路径（去掉 mainKey. 前缀）
            const relativePath = bestMatch.slice(mainKey.length + 1);
            childValue = _.get(item, relativePath);
          } else {
            // 如果没有匹配的 subPathKeys，直接从 item 中获取字段值
            childValue = _.get(item, relativeSubKey);
          }

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
        // 构建 TABLE 类型：value 是一个数组，每个元素是一个字段（SummaryDataSourceItem）
        const tableFields: SummaryDataSourceItem[] = targetFields.map((fieldName, idx) => {
          const fullSubKey = `${mainKey}.${fieldName}`;
          const childLabel = getFieldLabel(fullSubKey, collection);
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
    } else {
      // 非多对多字段：按照原本逻辑构造
      const childrenFullSubKeys = subPathKeys.filter((subKey) => subKey.startsWith(mainKey + '.'));

      if (childrenFullSubKeys.length > 0) {
        // 有子属性，需要构建 TABLE 类型或嵌套结构
        if (Array.isArray(parentValue) && parentValue.length > 0) {
          // 数组类型：构建 TABLE 类型
          const childValues: (string | number)[][] = [];
          let isValidTable = true;
          let rowCount = 0;

          for (const fullSubKey of childrenFullSubKeys) {
            const childArray: (string | number)[] = [];
            const relativeSubKey = fullSubKey.slice(mainKey.length + 1);

            for (const item of parentValue) {
              const childValue = _.get(item, relativeSubKey);
              const processedValue = processValue(childValue, fullSubKey, collection, app);
              childArray.push(processedValue);
            }
            childValues.push(childArray);

            if (rowCount === 0) {
              rowCount = childArray.length;
            } else if (rowCount !== childArray.length) {
              isValidTable = false;
            }
          }

          if (isValidTable && rowCount > 0) {
            const tableFields: SummaryDataSourceItem[] = childrenFullSubKeys.map((fullSubKey, idx) => {
              const childLabel = getFieldLabel(fullSubKey, collection);
              const relativeKey = fullSubKey.slice(mainKey.length + 1);
              return {
                key: relativeKey,
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
            summaryDataSource.push(getSummaryItem(mainKey, data, collection, app));
          }
        } else if (parentValue && typeof parentValue === 'object' && !Array.isArray(parentValue)) {
          // 单对象：构建嵌套对象结构
          const childObj: Record<string, any> = {};
          for (const fullSubKey of childrenFullSubKeys) {
            const value = _.get(data, fullSubKey);
            const relativeKey = fullSubKey.slice(mainKey.length + 1);
            childObj[relativeKey] = processValue(value, fullSubKey, collection, app);
          }
          summaryDataSource.push({
            key: mainKey,
            label,
            type: SUMMARY_TYPE.LITERAL,
            value: JSON.stringify(childObj),
          });
        } else {
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
  }

  return summaryDataSource;
}

export function getSummary(params: ParamsType): object {
  const { summaryConfig = [], data, collection, app } = params;

  const summaryDataSource = getSummaryDataSource({ summaryConfig, data, collection, app });

  return summaryDataSource;

  // const result = summaryConfig.reduce((summary, key) => {
  //   const value = _.get(data, key);
  //   let realValue = value;
  //   if (Object.prototype.toString.call(value) === '[object Object]' && !Array.isArray(value)) {
  //     // 优先获取关联表的 titleField 值
  //     const fieldName = key.split('.')[0];
  //     const titleFieldValue = getAssociationTitleFieldValue(value, fieldName, collection, app);
  //     realValue = titleFieldValue !== undefined ? titleFieldValue : value?.['name'];
  //   }
  //   return {
  //     ...summary,
  //     [key]: realValue,
  //   };
  // }, {});

  // return result;
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
