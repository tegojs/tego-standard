/**
 * title: TreeSelect
 */
import React from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { TreeSelect } from '../TreeSelect';

const TestFormItem = ({ children }) => {
  const schema = useFieldSchema();
  return (
    <label>
      <span>{schema.title}</span>
      {children}
    </label>
  );
};

const dataSource = [
  {
    label: '选项1',
    value: 1,
    children: [
      {
        label: 'Child Node1',
        value: '0-0-0',
      },
      {
        label: 'Child Node2',
        value: '0-0-1',
      },
      {
        label: 'Child Node3',
        value: '0-0-2',
      },
    ],
  },
  {
    label: '选项2',
    value: 2,
    children: [
      {
        label: 'Child Node1',
        value: '0-1-0',
      },
      {
        label: 'Child Node2',
        value: '0-1-1',
      },
      {
        label: 'Child Node3',
        value: '0-1-2',
      },
    ],
  },
];
const schema = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'TreeSelect',
      'x-component-props': {
        treeData: dataSource,
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
      'x-component': 'TreeSelect',
      'x-component-props': {
        treeData: dataSource,
      },
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ TreeSelect, FormItem: TestFormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
