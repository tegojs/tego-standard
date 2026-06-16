import { Schema, useFieldSchema } from '@tachybase/schema';

import { useOperatorList } from '../filter/useOperators';

export const findFilterOperators = (schema: Schema) => {
  while (schema) {
    if (schema['x-filter-operators']) {
      return {
        operators: schema['x-filter-operators'],
        uid: schema['x-uid'],
      };
    }
    schema = schema.parent;
  }
  return {};
};

const getSchemaFilterComponent = (schema: Schema) => {
  return schema?.['x-component-props']?.component || schema?.['x-component'];
};

export const getDefaultFilterOperatorValue = (schema: Schema, operatorList: any[] = []) => {
  const component = getSchemaFilterComponent(schema);
  if (component) {
    const matched = operatorList.find((item) => item?.schema?.['x-component'] === component);
    if (matched?.value) {
      return matched.value;
    }
  }

  return operatorList.find((item) => item?.selected)?.value || operatorList[0]?.value;
};

/**
 * 如果用户没有手动设置过 operator，那么在筛选的时候 operator 会是空的，
 * 该方法确保 operator 一定有值（需要在 FormItem 中调用）
 */
export const useEnsureOperatorsValid = () => {
  const fieldSchema = useFieldSchema();
  const operatorList = useOperatorList();
  const { operators: storedOperators } = findFilterOperators(fieldSchema);

  if (storedOperators && operatorList.length && !storedOperators[fieldSchema.name]) {
    storedOperators[fieldSchema.name] = getDefaultFilterOperatorValue(fieldSchema, operatorList);
  }
};
