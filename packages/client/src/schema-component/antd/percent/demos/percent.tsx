import React from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Percent } from '../Percent';

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
      type: 'number',
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'Percent',
      'x-reactions': {
        target: 'read',
        fulfill: {
          state: {
            value: '{{$self.value}}',
          },
        },
      },
    },
    read: {
      type: 'number',
      title: `Read pretty`,
      'x-read-pretty': true,
      'x-decorator': 'FormItem',
      'x-component': 'Percent',
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ Percent, FormItem: TestFormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
