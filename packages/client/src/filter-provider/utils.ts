import { useCallback, useEffect, useState } from 'react';
import { Schema, useFieldSchema } from '@tachybase/schema';
import { flatten, getValuesByPath } from '@tego/client';

import _ from 'lodash';

import { FilterTarget, findFilterTargets } from '../block-provider/hooks';
import {
  Collection_deprecated,
  CollectionFieldOptions_deprecated,
  FieldOptions,
  useCollection_deprecated,
  useCollectionManager_deprecated,
} from '../collection-manager';
import { removeNullCondition } from '../schema-component';
import { resolveDatePickerRangeValueInfo } from '../schema-component/antd/date-picker/util';
import {
  FILTER_OPERATORS_WITH_ARRAY_VALUES,
  normalizeDateBetweenValue,
  shouldUseDefaultDateBoundary,
} from '../schema-component/antd/filter/dateValueUtils';
import {
  findFilterOperators,
  getDefaultFilterOperatorValue,
} from '../schema-component/antd/form-item/SchemaSettingOptions';
import { DataBlock, useFilterBlock } from './FilterProvider';
import { getFilterSourceDefaultFilter } from './incomingFilterFromSources';

export enum FilterBlockType {
  FORM,
  TABLE,
  TREE,
  COLLAPSE,
}

export const mergeFilter = (filters: any[], op = '$and') => {
  const items = filters.filter((f) => {
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      return Object.values(f).filter((v) => v !== undefined).length;
    }
  });
  if (items.length === 0) {
    return {};
  }
  if (items.length === 1) {
    return items[0];
  }
  return { [op]: items };
};

export { FILTER_OPERATORS_WITH_ARRAY_VALUES, normalizeDateBetweenValue, shouldUseDefaultDateBoundary };

export const getSupportFieldsByAssociation = (inheritCollectionsChain: string[], block: DataBlock) => {
  return block.associatedFields?.filter((field) =>
    inheritCollectionsChain?.some((collectionName) => collectionName === field.target),
  );
};

export const getSupportFieldsByForeignKey = (
  filterBlockCollection: ReturnType<typeof useCollection_deprecated>,
  block: DataBlock,
) => {
  return block.foreignKeyFields?.filter((foreignKeyField) => {
    return filterBlockCollection.fields.some(
      (field) => field.type !== 'belongsTo' && field.foreignKey === foreignKeyField.name,
    );
  });
};

/**
 * 根据筛选卡片类型筛选出支持的数据卡片（同表或具有关系字段的表）
 * @param filterBlockType
 * @returns
 */
export const useSupportedBlocks = (filterBlockType: FilterBlockType) => {
  const { getDataBlocks } = useFilterBlock();
  const fieldSchema = useFieldSchema();
  const collection = useCollection_deprecated();
  const { getAllCollectionsInheritChain } = useCollectionManager_deprecated();

  // Form 和 Collapse 仅支持同表的数据卡片
  if (filterBlockType === FilterBlockType.FORM || filterBlockType === FilterBlockType.COLLAPSE) {
    return getDataBlocks().filter((block) => {
      return isSameCollection(block.collection, collection);
    });
  }

  // Table 和 Tree 支持同表或者关系表的数据卡片
  if (filterBlockType === FilterBlockType.TABLE || filterBlockType === FilterBlockType.TREE) {
    return getDataBlocks().filter((block) => {
      // 1. 同表
      // 2. 关系字段
      // 3. 外键字段
      return (
        fieldSchema['x-uid'] !== block.uid &&
        (isSameCollection(block.collection, collection) ||
          getSupportFieldsByAssociation(getAllCollectionsInheritChain(collection.name, collection.dataSource), block)
            ?.length ||
          getSupportFieldsByForeignKey(collection, block)?.length)
      );
    });
  }
};

const findSchemaByName = (schema: any, name: string): any => {
  if (!schema) {
    return null;
  }

  if (schema.name === name) {
    return schema;
  }

  const properties = schema.properties || {};
  for (const key of Object.keys(properties)) {
    if (key === name) {
      return properties[key];
    }
    const found = findSchemaByName(properties[key], name);
    if (found) {
      return found;
    }
  }

  return null;
};

const getFilterSchemaRoot = (schema: any) => {
  let current = schema;
  while (current) {
    if (current['x-filter-operators'] || current['x-filter-targets']) {
      return current;
    }
    current = current.parent;
  }
  return schema;
};

const resolveFilterOperator = (
  schema: Schema,
  path: string,
  operators: Record<string, string> = {},
  getOperatorList?: (
    path: string,
    options: { fieldSchema?: Schema; collectionField?: CollectionFieldOptions_deprecated },
  ) => any[],
  collectionField?: CollectionFieldOptions_deprecated,
) => {
  if (operators[path]) {
    return operators[path];
  }

  if (!getOperatorList) {
    return undefined;
  }

  const fieldSchema = findSchemaByName(getFilterSchemaRoot(schema), path);
  const operatorList = getOperatorList(path, { fieldSchema, collectionField }) || [];

  if (!operatorList.length || !fieldSchema) {
    return undefined;
  }

  return getDefaultFilterOperatorValue(fieldSchema, operatorList);
};

const getDatePickerComponent = (fieldSchema?: any) => {
  if (fieldSchema?.['x-component'] === 'CollectionField') {
    return fieldSchema?.['x-component-props']?.component;
  }
  return fieldSchema?.['x-component'] || fieldSchema?.['x-component-props']?.component;
};

const getDatePickerShowTime = (fieldSchema?: any) => {
  return fieldSchema?.['x-component-props']?.showTime;
};

export const transformToFilter = (
  values: Record<string, any>,
  fieldSchema: Schema,
  getCollectionJoinField: (name: string) => CollectionFieldOptions_deprecated,
  collectionName: string,
  getOperatorList?: (
    path: string,
    options: { fieldSchema?: Schema; collectionField?: CollectionFieldOptions_deprecated },
  ) => any[],
) => {
  const { operators } = findFilterOperators(fieldSchema);

  values = flatten(values, {
    breakOn({ value, path }) {
      const collectionField = getCollectionJoinField(`${collectionName}.${path}`);
      const operator = resolveFilterOperator(fieldSchema, path, operators, getOperatorList, collectionField);

      // 下面操作符的值是一个数组，需要特殊处理
      if (FILTER_OPERATORS_WITH_ARRAY_VALUES.has(operator)) {
        return true;
      }

      if (collectionField?.target) {
        if (Array.isArray(value)) {
          return true;
        }
        const targetKey = collectionField.targetKey || 'id';
        if (value && value[targetKey] != null) {
          return true;
        }
      }
      return false;
    },
  });

  const result = {
    $and: Object.keys(values)
      .map((key) => {
        const defKey = key;
        let value = _.get(values, key);
        const collectionField = getCollectionJoinField(`${collectionName}.${key}`);
        const currentFieldSchema = findSchemaByName(getFilterSchemaRoot(fieldSchema), defKey);
        const operator = resolveFilterOperator(fieldSchema, defKey, operators, getOperatorList, collectionField);
        if (collectionField?.target) {
          value = getValuesByPath(value, collectionField.targetKey || 'id');
          key = `${key}.${collectionField.targetKey || 'id'}`;
        }

        if (!value) {
          return null;
        }
        // 处理布尔类型
        if (operator === '$isTruly' || operator === '$isFalsy') {
          if (value === 'true') {
            return {
              [key]: {
                $isTruly: true,
              },
            };
          } else if (value === 'false') {
            return {
              [key]: {
                $isFalsy: true,
              },
            };
          }
        } else if (operator === '$dateBetween') {
          if (Array.isArray(value)) {
            const datePickerComponent = getDatePickerComponent(currentFieldSchema);
            const useDefaultDateBoundary = shouldUseDefaultDateBoundary(currentFieldSchema);
            const valueInfo = resolveDatePickerRangeValueInfo(value, {
              component: datePickerComponent,
              showTime: getDatePickerShowTime(currentFieldSchema),
              preferDateBoundaryFallback: useDefaultDateBoundary,
            });
            value = normalizeDateBetweenValue(value, {
              useDefaultDateBoundary,
              valueMode: valueInfo.mode,
              valueSource: valueInfo.source,
              preferDateBoundaryFallback: valueInfo.source === 'retained-date-boundary',
            });
            if (!value) {
              return null;
            }
          }
        }
        return {
          [key]: {
            [operators[key] || operator || '$eq']: value,
          },
        };
      })
      .filter(Boolean),
  };

  return result;
};

export const useAssociatedFields = () => {
  const { fields } = useCollection_deprecated();

  return fields.filter((field) => isAssocField(field)) || [];
};

export const isAssocField = (field?: FieldOptions) => {
  return ['o2o', 'oho', 'obo', 'm2o', 'createdBy', 'updatedBy', 'o2m', 'm2m', 'linkTo', 'chinaRegion'].includes(
    field?.interface,
  );
};

export const isSameCollection = (c1: Collection_deprecated, c2: Collection_deprecated) => {
  return c1.name === c2.name && c1.dataSource === c2.dataSource;
};

export const useFilterAPI = () => {
  const fieldSchema = useFieldSchema();
  const { getDataBlocks } = useFilterBlock();
  const { targets, uid } = findFilterTargets(fieldSchema);
  const dataBlocks = getDataBlocks();
  const [isConnected, setIsConnected] = useState(() => {
    return targets && targets.some((target) => dataBlocks.some((dataBlock) => dataBlock.uid === target.uid));
  });
  const targetsKeys = Object.keys(targets || {});

  useEffect(() => {
    setIsConnected(targets && targets.some((target) => dataBlocks.some((dataBlock) => dataBlock.uid === target.uid)));
  }, [targetsKeys.length, dataBlocks]);

  const doFilter = useCallback(
    (
      value,
      field: string | ((target: FilterTarget['targets'][0]) => string) = 'id',
      operator: string | ((target: FilterTarget['targets'][0]) => string) = '$eq',
    ) => {
      dataBlocks.forEach((block) => {
        const target = targets.find((target) => target.uid === block.uid);
        if (!target) return;

        if (_.isFunction(field)) {
          field = field(target);
        }
        if (_.isFunction(operator)) {
          operator = operator(target);
        }

        const param = block.service.params?.[0] || {};
        // 保留原有的 filter
        const storedFilter = block.service.params?.[1]?.filters || {};

        if (value !== undefined) {
          storedFilter[uid] = {
            $and: [
              {
                [field]: {
                  [operator]: value,
                },
              },
            ],
          };
        } else {
          delete storedFilter[uid];
        }

        const mergedFilter = mergeFilter([
          ...Object.values(storedFilter).map((filter) => removeNullCondition(filter)),
          getFilterSourceDefaultFilter(dataBlocks, uid),
          block.defaultFilter,
        ]);

        block.doFilter(
          {
            ...param,
            page: 1,
            filter: mergedFilter,
          },
          { filters: storedFilter },
        );
      });
    },
    [dataBlocks],
  );

  return {
    /** 当前卡片是否已连接其它卡片 */
    isConnected,
    /** 调用该方法进行过滤 */
    doFilter,
  };
};

export const isInFilterFormBlock = (fieldSchema: Schema) => {
  while (fieldSchema) {
    if (fieldSchema['x-filter-targets']) {
      return fieldSchema['x-decorator'] === 'FilterFormBlockProvider';
    }
    fieldSchema = fieldSchema.parent;
  }
  return false;
};
