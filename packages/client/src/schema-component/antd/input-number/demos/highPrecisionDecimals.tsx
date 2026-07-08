import React from 'react';
import { useField } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { InputNumber } from '../InputNumber';

const FormItem = ({ children }) => {
  const field = useField();
  return (
    <div>
      {field?.title && <label>{field.title}</label>}
      {children}
    </div>
  );
};

const schema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'InputNumber',
      'x-component-props': {
        stringMode: true,
        step: '0.01',
        addonAfter: '%',
      },
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
      type: 'string',
      title: `Read pretty`,
      'x-read-pretty': true,
      'x-decorator': 'FormItem',
      'x-component': 'InputNumber',
      'x-component-props': {
        stringMode: true,
        step: '0.01',
        addonAfter: '%',
      },
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ InputNumber, FormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
