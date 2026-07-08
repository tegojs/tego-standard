import React from 'react';
import { useField } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { IconPicker } from '../IconPicker';

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
      type: 'boolean',
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'IconPicker',
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
      type: 'boolean',
      title: `Read pretty`,
      'x-read-pretty': true,
      'x-decorator': 'FormItem',
      'x-component': 'IconPicker',
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ IconPicker, FormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
