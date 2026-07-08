import React from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { FormProvider } from '../../../core/FormProvider';
import { SchemaComponent } from '../../../core/SchemaComponent';
import { Input } from '../../input/Input';

const TestFormItem = ({ children }) => {
  const schema = useFieldSchema();
  return (
    <label>
      <span>{schema.title}</span>
      {children}
    </label>
  );
};

const schema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      title: 'title',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
    },
  },
};

export default () => {
  return (
    <FormProvider>
      <SchemaComponent components={{ FormItem: TestFormItem, Input }} schema={schema} />
    </FormProvider>
  );
};
