import { Field, useField, useFieldSchema } from '@tachybase/schema';

import flat from 'flat';
import _ from 'lodash';
import { useTranslation } from 'react-i18next';

import { useBlockRequestContext } from '../../../block-provider';
import { useCollection_deprecated, useCollectionManager_deprecated } from '../../../collection-manager';
import {
  FILTER_OPERATORS_WITH_ARRAY_VALUES,
  mergeFilter,
  normalizeDateBetweenValue,
  shouldUseDefaultDateBoundary,
} from '../../../filter-provider/utils';
import { useDataLoadingMode } from '../../../modules/blocks/data-blocks/details-multi/setDataLoadingModeSettingsItem';
import { resolveDatePickerRangeValueInfo } from '../date-picker/util';
import { hasDuplicateKeys } from './utils';

export const useGetFilterOptions = () => {
  const { getCollectionFields } = useCollectionManager_deprecated();
  const getFilterFieldOptions = useGetFilterFieldOptions();

  return (collectionName, dataSource?: string) => {
    const fields = getCollectionFields(collectionName, dataSource);
    const options = getFilterFieldOptions(fields);
    return options;
  };
};

export const useFilterOptions = (collectionName: string) => {
  const { getCollectionFields } = useCollectionManager_deprecated();
  const fields = getCollectionFields(collectionName);
  const options = useFilterFieldOptions(fields);
  return options;
};

export const useGetFilterFieldOptions = () => {
  const fieldSchema = useFieldSchema();
  const nonfilterable = fieldSchema?.['x-component-props']?.nonfilterable || [];
  const { getCollectionFields, getInterface } = useCollectionManager_deprecated();
  const field2option = (field, depth) => {
    if (nonfilterable.length && depth === 1 && nonfilterable.includes(field.name)) {
      return;
    }
    if (!field.interface) {
      return;
    }
    const fieldInterface = getInterface(field.interface);
    if (!fieldInterface?.filterable) {
      return;
    }
    const { nested, children, operators } = fieldInterface.filterable;
    const option = {
      name: field.name,
      type: field.type,
      target: field.target,
      title: field?.uiSchema?.title || field.name,
      schema: field?.uiSchema,
      interface: field.interface,
      operators:
        operators?.filter?.((operator) => {
          return !operator?.visible || operator.visible(field);
        }) || [],
    };
    if (field.target && depth > 2) {
      return;
    }
    if (depth > 2) {
      return option;
    }
    if (children?.length) {
      option['children'] = children;
    }
    if (nested) {
      const targetFields = getCollectionFields(field.target);
      const options = getOptions(targetFields, depth + 1).filter(Boolean);
      option['children'] = option['children'] || [];
      option['children'].push(...options);
    }
    return option;
  };
  const getOptions = (fields, depth) => {
    const options = [];
    fields.forEach((field) => {
      const option = field2option(field, depth);
      if (option) {
        options.push(option);
      }
    });
    return options;
  };
  return (fields) => getOptions(fields, 1);
};

export const useFilterFieldOptions = (fields) => {
  const fieldSchema = useFieldSchema();
  const nonfilterable = fieldSchema?.['x-component-props']?.nonfilterable || [];
  const { getCollectionFields, getInterface } = useCollectionManager_deprecated();
  const field2option = (field, depth) => {
    if (nonfilterable.length && depth === 1 && nonfilterable.includes(field.name)) {
      return;
    }
    if (!field.interface) {
      return;
    }
    const fieldInterface = getInterface(field.interface);
    if (!fieldInterface?.filterable) {
      return;
    }
    const { nested, children, operators } = fieldInterface.filterable;
    const option = {
      name: field.name,
      type: field.type,
      target: field.target,
      title: field?.uiSchema?.title || field.name,
      schema: field?.uiSchema,
      operators:
        operators?.filter?.((operator) => {
          return !operator?.visible || operator.visible(field);
        }) || [],
    };
    if (field.target && depth > 2) {
      return;
    }
    if (depth > 2) {
      return option;
    }
    if (children?.length) {
      option['children'] = children;
    }
    if (nested) {
      const targetFields = getCollectionFields(field.target);
      const options = getOptions(targetFields, depth + 1).filter(Boolean);
      option['children'] = option['children'] || [];
      option['children'].push(...options);
    }
    return option;
  };
  const getOptions = (fields, depth) => {
    const options = [];
    fields.forEach((field) => {
      const option = field2option(field, depth);
      if (option) {
        options.push(option);
      }
    });
    return options;
  };
  return getOptions(fields, 1);
};

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
        if (!filterSchemaItem[item] || filterSchemaItem[item].includes('$nFilter')) {
          delete filterSchemaItem[item];
        }
      }
      const flatFieldSchema = customFlat.unflatten(filterSchemaItem);
      flatFieldSchema['$and'] = flatFieldSchema?.['$and']?.filter(Boolean);
      flatFieldSchema['$or'] = flatFieldSchema?.['$or']?.filter(Boolean);
      if (!flatFieldSchema['$and']?.length) {
        delete flatFieldSchema['$and'];
      }
      if (!flatFieldSchema['$or']?.length) {
        delete flatFieldSchema['$or'];
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

export const useFilterActionProps = () => {
  const { name } = useCollection_deprecated();
  const options = useFilterOptions(name);
  const { service, props } = useBlockRequestContext();
  return useFilterFieldProps({ options, service, params: props?.params });
};

export const useFilterFieldProps = ({ options, service, params }) => {
  const { t } = useTranslation();
  const field = useField<Field>();
  const dataLoadingMode = useDataLoadingMode();

  return {
    options,
    onSubmit(values) {
      // filter parameter for the block
      const defaultFilter = params.filter;
      // filter parameter for the filter action
      const filter = removeNullCondition(values?.filter) as any;

      if (dataLoadingMode === 'manual' && _.isEmpty(filter)) {
        return service.mutate(undefined);
      }

      const filters = service.params?.[1]?.filters || {};
      filters[`filterAction`] = filter;
      service.run(
        { ...service.params?.[0], page: 1, filter: mergeFilter([...Object.values(filters), defaultFilter]) },
        { filters },
      );
      const items = filter?.$and || filter?.$or;
      if (items?.length) {
        field.title = t('{{count}} filter items', { count: items?.length || 0 });
      } else {
        field.title = t('Filter');
      }
    },
    onReset() {
      const filter = params.filter;
      const filters = service.params?.[1]?.filters || {};
      delete filters[`filterAction`];

      const newParams = [
        {
          ...service.params?.[0],
          filter: mergeFilter([...Object.values(filters), filter]),
          page: 1,
        },
        { filters },
      ];

      field.title = t('Filter');

      if (dataLoadingMode === 'manual') {
        service.params = newParams;
        return service.mutate(undefined);
      }

      service.run(...newParams);
    },
  };
};
