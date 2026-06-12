import flat from 'flat';

import { resolveDatePickerRangeValueInfo } from '../date-picker/util';
import {
  FILTER_OPERATORS_WITH_ARRAY_VALUES,
  normalizeDateBetweenValue,
  shouldUseDefaultDateBoundary,
} from './dateValueUtils';
import { hasDuplicateKeys } from './utils';

const isEmpty = (obj) => {
  return (
    (Array.isArray(obj) && obj.length === 0) ||
    (obj && Object.keys(obj).length === 0 && Object.getPrototypeOf(obj) === Object.prototype)
  );
};

const CUSTOM_FILTER_VARIABLE_REGEXP = /^\{\{\$nFilter\.([^}]+)\}\}$/;

const getCustomFilterValue = (items, key, rawItems: any = {}) => {
  if (rawItems && key in rawItems) {
    return rawItems[key];
  }

  if (key in items) {
    return items[key];
  }

  const arrayItems = Object.keys(items)
    .filter((itemKey) => itemKey.startsWith(`${key}.`) && /^\d+$/.test(itemKey.slice(key.length + 1)))
    .sort((a, b) => Number(a.slice(key.length + 1)) - Number(b.slice(key.length + 1)))
    .map((itemKey) => items[itemKey]);

  return arrayItems.length ? arrayItems : undefined;
};

const findCustomFieldSchemaInTree = (schema, key) => {
  if (!schema) {
    return null;
  }
  if (schema.name === `__custom.${key}` || schema.name === key) {
    return schema;
  }
  const properties = schema.properties || {};
  for (const propertyKey of Object.keys(properties)) {
    if (propertyKey === `__custom.${key}` || propertyKey === key) {
      return properties[propertyKey];
    }
    const found = findCustomFieldSchemaInTree(properties[propertyKey], key);
    if (found) {
      return found;
    }
  }
  return null;
};

const findCustomFieldSchema = (schema, key) => {
  let current = schema;
  while (current) {
    const found = findCustomFieldSchemaInTree(current, key);
    if (found) {
      return found;
    }
    current = current.parent;
  }
  return null;
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

const expandArrayValueFilter = (filterSchemaItem, filterKey, value, customFlat, options: any = {}) => {
  const pathParts = filterKey.split('.');
  const operator = pathParts.pop();
  if (operator === '$dateBetween' && Array.isArray(value)) {
    const valueInfo = resolveDatePickerRangeValueInfo(value, {
      component: options.component,
      showTime: options.showTime,
      preferDateBoundaryFallback: options.useDefaultDateBoundary,
    });
    filterSchemaItem[filterKey] = normalizeDateBetweenValue(value, {
      useDefaultDateBoundary: options.useDefaultDateBoundary,
      valueMode: valueInfo.mode,
      valueSource: valueInfo.source,
      preferDateBoundaryFallback: valueInfo.source === 'retained-date-boundary',
    });
    return;
  }

  if (!Array.isArray(value) || FILTER_OPERATORS_WITH_ARRAY_VALUES.has(operator || '')) {
    filterSchemaItem[filterKey] = value;
    return;
  }

  if (value.length === 0) {
    delete filterSchemaItem[filterKey];
    return;
  }

  let branchEndIndex = -1;
  for (let index = pathParts.length - 2; index >= 0; index--) {
    if (['$and', '$or'].includes(pathParts[index]) && /^\d+$/.test(pathParts[index + 1])) {
      branchEndIndex = index;
      break;
    }
  }

  const branchPath = branchEndIndex >= 0 ? pathParts.slice(0, branchEndIndex + 2).join('.') : '';
  const fieldPath = pathParts.slice(branchEndIndex + 2).join('.');
  const conditions = value.map((item) => customFlat.unflatten({ [`${fieldPath}.${operator}`]: item }));
  delete filterSchemaItem[filterKey];
  filterSchemaItem[branchPath ? `${branchPath}.$or` : '$or'] = conditions;
};

export const getCustomCondition: any = (filter, fieldSchema, customFlat = flat) => {
  const filterSchema = fieldSchema ? fieldSchema['x-filter-rules'] : '';
  const filterSchemaItem = customFlat(filterSchema || '') as any;
  const items = customFlat(filter || {}) as any;
  const isCustomFilter = filterSchema?.$and?.length || filterSchema?.$or?.length;
  const isFilterCustom = isCustomFilter ? hasDuplicateKeys(items, filterSchemaItem) : false;
  if (!isFilterCustom) {
    if (isCustomFilter) {
      for (const filterKey in filterSchemaItem) {
        const match =
          typeof filterSchemaItem[filterKey] === 'string' &&
          filterSchemaItem[filterKey].match(CUSTOM_FILTER_VARIABLE_REGEXP);
        if (!match) {
          continue;
        }
        const customFieldSchema = findCustomFieldSchema(fieldSchema, match[1]);
        expandArrayValueFilter(
          filterSchemaItem,
          filterKey,
          getCustomFilterValue(items, match[1], filter || {}),
          customFlat,
          {
            useDefaultDateBoundary: shouldUseDefaultDateBoundary(customFieldSchema),
            component: getDatePickerComponent(customFieldSchema),
            showTime: getDatePickerShowTime(customFieldSchema),
          },
        );
      }
      for (const item in filterSchemaItem) {
        const value = filterSchemaItem[item];
        if (value == null || value === '' || (typeof value === 'string' && value.includes('$nFilter'))) {
          delete filterSchemaItem[item];
        }
      }
      const flatFieldSchema = customFlat.unflatten(filterSchemaItem);
      if (Array.isArray(flatFieldSchema?.['$and'])) {
        flatFieldSchema['$and'] = flatFieldSchema['$and'].filter(Boolean);
      }
      if (Array.isArray(flatFieldSchema?.['$or'])) {
        flatFieldSchema['$or'] = flatFieldSchema['$or'].filter(Boolean);
      }

      return flatFieldSchema;
    } else {
      return customFlat.unflatten({});
    }
  } else {
    return customFlat.unflatten(items);
  }
};

export const removeNullCondition: any = (filter, customFlat = flat) => {
  const items = customFlat(filter || {}) as any;
  const values = {};
  for (const key in items) {
    const value = items[key];
    if (value != null && !isEmpty(value)) {
      values[key] = value;
    }
  }
  // $dateBetween 需要 [start, end]；第二项为 null 时会在上面被丢弃，需补全否则后端报 Invalid Date
  for (const key of Object.keys(values)) {
    if (key.endsWith('$dateBetween.0')) {
      const key1 = key.replace(/\$dateBetween\.0$/, '$dateBetween.1');
      if (!(key1 in values)) {
        values[key1] = values[key];
      }
    } else if (key.endsWith('$dateBetween.1')) {
      const key0 = key.replace(/\$dateBetween\.1$/, '$dateBetween.0');
      if (!(key0 in values)) {
        values[key0] = values[key];
      }
    }
  }
  return customFlat.unflatten(values);
};
