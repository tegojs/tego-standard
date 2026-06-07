/**
 * title: Markdown
 */
import React from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Markdown } from '../Markdown';

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
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'Markdown',
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
      'x-component': 'Markdown',
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ Markdown, FormItem: TestFormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
