import React from 'react';
import {
  useCollection_deprecated,
  useCollectionManager_deprecated,
  useCompile,
  useFormulaTitleOptions,
  useRecord,
  Variable,
} from '@tachybase/client';

export const Expression = (props) => {
  const { value = '', supports = [], useCurrentFields, onChange } = props;
  const compile = useCompile();
  const { getCollectionFields } = useCollectionManager_deprecated();

  const options = getOptions(compile, getCollectionFields, useCurrentFields?.() ?? []);

  return <Variable.TextArea value={value} onChange={onChange} scope={options} />;
};

export default Expression;

const getOptions = (compile, getCollectionFields, fields) => {
  const options = [];
  fields?.forEach((field) => {
    if (
      !['m2m', 'o2m'].includes(field.interface) &&
      ['hasOne', 'hasMany', 'belongsTo', 'belongsToMany'].includes(field.type)
    ) {
      if (field.uiSchema) {
        options.push({
          label: compile(field.uiSchema.title),
          value: field.name,
          children:
            getCollectionFields(field.target)
              ?.filter((subField) => subField.uiSchema)
              .map((subField) => ({
                label: subField.uiSchema ? compile(subField.uiSchema.title) : '',
                value: subField.name,
              })) ?? [],
        });
      }
    }
    if (!['hasOne', 'hasMany', 'belongsTo', 'belongsToMany'].includes(field.type)) {
      options.push({
        label: compile(field.uiSchema.title),
        value: field.name,
        children:
          getCollectionFields(field.target)
            ?.filter((subField) => subField.uiSchema)
            .map((subField) => ({
              label: subField.uiSchema ? compile(subField.uiSchema.title) : '',
              value: subField.name,
            })) ?? [],
      });
    }
  });
  return options;
};
