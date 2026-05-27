import React, { useState } from 'react';
import { ISchema } from '@tachybase/schema';

import { Space } from 'antd';

import { SchemaComponent, SchemaComponentProvider } from '../../../core';
import { Input } from '../../input';
import { InputNumber } from '../../input-number';
import { Select } from '../../select';
import { Filter } from '../Filter';

const options: any = [
  {
    name: 'name',
    title: 'Name',
    operators: [
      { label: 'eq', value: '$eq' },
      { label: 'ne', value: '$ne' },
    ],
    schema: {
      type: 'string',
      title: 'Name',
      'x-component': 'Input',
    },
  },
  {
    name: 'age',
    title: 'Age',
    operators: [
      { label: 'in', value: '$in' },
      { label: 'not', value: '$not' },
    ],
    schema: {
      type: 'string',
      title: 'Age',
      'x-component': 'InputNumber',
    },
  },
  {
    name: 'tags',
    title: 'Tags',
    schema: {
      title: 'Tags',
    },
    children: [
      {
        name: 'slug',
        title: 'Slug',
        operators: [
          { label: 'in', value: '$in' },
          { label: 'not', value: '$not' },
        ],
        schema: {
          title: 'Slug',
          type: 'string',
          'x-component': 'Input',
        },
      },
      {
        name: 'title',
        title: 'Title',
        operators: [
          { label: 'eq', value: '$eq' },
          { label: 'ne', value: '$ne' },
        ],
        schema: {
          title: 'Title',
          type: 'string',
          'x-component': 'Input',
        },
      },
    ],
  },
];

const defaultValue = {
  $or: [
    {
      name: {
        $ne: 'aaa',
      },
    },
    {
      'tags.title': {
        $eq: 'bbb',
      },
    },
  ],
};

const schema: ISchema = {
  type: 'void',
  properties: {
    demo: {
      name: 'filter',
      type: 'object',
      enum: options,
      default: defaultValue,
      'x-component': 'Filter',
      'x-component-props': {
        dynamicComponent: 'CustomDynamicComponent',
      },
    },
  },
};
const ExpRE = /^\s*\{\{([\s\S]*)\}\}\s*$/;

const CustomDynamicComponent = (props) => {
  const { value, onChange, renderSchemaComponent } = props;
  let matched = null;
  if (typeof value === 'string') {
    matched = ExpRE.exec(value);
  }
  const [source, setSource] = useState(matched ? 'node1' : 'default');
  const options = [
    {
      label: '字段1',
      value: `{{${source}.field1}}`,
    },
    {
      label: '字段2',
      value: `{{${source}.field2}}`,
    },
  ];
  return (
    <Space>
      <Select
        style={{ minWidth: 120 }}
        value={source}
        onChange={(value) => {
          setSource(value);
          onChange(null);
        }}
        options={[
          {
            label: '默认',
            value: 'default',
          },
          {
            label: '节点1',
            value: 'node1',
          },
        ]}
      />
      {source === 'default' ? (
        renderSchemaComponent()
      ) : (
        <Select
          style={{ minWidth: 120 }}
          onChange={(value) => {
            onChange(value);
          }}
          value={value}
          options={options}
        />
      )}
    </Space>
  );
};

export default () => {
  return (
    <SchemaComponentProvider components={{ Filter, Input, InputNumber, Select, CustomDynamicComponent }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
