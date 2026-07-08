import { useFieldSchema } from '@tachybase/schema';

import { useCollectionManager_deprecated } from '../../../collection-manager';

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

export const useGetFilterOptions = () => {
  const { getCollectionFields } = useCollectionManager_deprecated();
  const getFilterFieldOptions = useGetFilterFieldOptions();

  return (collectionName, dataSource?: string) => {
    const fields = getCollectionFields(collectionName, dataSource);
    const options = getFilterFieldOptions(fields);
    return options;
  };
};
