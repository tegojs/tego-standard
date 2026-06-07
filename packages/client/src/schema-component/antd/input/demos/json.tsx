import React from 'react';
import { observer, useField } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Input } from '../Input';

const FormItem = observer(({ children }) => {
  const field = useField();
  return (
    <div>
      {field?.title && <label>{field.title}</label>}
      {children}
      {field?.selfErrors?.map((error) => (
        <div key={error}>{error}</div>
      ))}
    </div>
  );
});

const schema = {
  type: 'object',
  properties: {
    input: {
      type: 'object',
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'Input.JSON',
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
      'x-component': 'Input.JSON',
    },
  },
};

const Root = () => {
  return (
    <SchemaComponentProvider components={{ Input, FormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};

export default Root;
