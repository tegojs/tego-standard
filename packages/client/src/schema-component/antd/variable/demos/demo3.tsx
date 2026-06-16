/**
 * title: Variable.Input
 */
import React from 'react';
import { observer, useField } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Variable } from '../Variable';

const FormItem = observer(({ children }) => {
  const field = useField();
  return (
    <div>
      {field?.title && <label>{field.title}</label>}
      {children}
    </div>
  );
});

const scope = [
  { label: 'v1', value: 'v1' },
  { label: 'nested', value: 'nested', children: [{ label: 'v2', value: 'v2' }] },
];

const schema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      title: `JSON 模式`,
      'x-decorator': 'FormItem',
      'x-component': 'Variable.JSON',
      'x-component-props': {
        scope,
      },
      // 'x-reactions': {
      //   target: 'read',
      //   fulfill: {
      //     state: {
      //       value: '{{$self.value}}',
      //     },
      //   },
      // },
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ Variable, FormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
