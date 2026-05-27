import React, { useMemo, useState } from 'react';

import { Select } from 'antd';

import { SchemaComponent, SchemaComponentProvider } from '../../../core';
import { Input } from '../../input';
import { Filter } from '../Filter';

const optionsByCollection = {
  test1: [
    {
      name: 'title1',
      type: 'string',
      title: 'Title1',
      schema: {
        title: 'Title1',
        type: 'string',
        'x-component': 'Input',
        required: true,
      },
      interface: 'input',
      operators: [{ label: 'contains', value: '$includes' }],
    },
  ],
  test2: [
    {
      name: 'title2',
      type: 'string',
      title: 'Title2',
      schema: {
        title: 'Title2',
        type: 'string',
        'x-component': 'Input',
        required: true,
      },
      interface: 'input',
      operators: [{ label: 'contains', value: '$includes' }],
    },
  ],
};

const SwitchCollection = () => {
  const [collection, setCollection] = useState<'test1' | 'test2'>('test1');
  const schema = useMemo(
    () => ({
      type: 'void',
      properties: {
        [collection]: {
          name: `filter_${collection}`,
          type: 'object',
          'x-component': 'Filter',
          default: { $and: [{}] },
          'x-component-props': {
            options: optionsByCollection[collection],
          },
        },
      },
    }),
    [collection],
  );

  return (
    <div>
      <Select
        options={[
          { label: 'test1', value: 'test1' },
          { label: 'test2', value: 'test2' },
        ]}
        value={collection}
        onChange={(value) => {
          setCollection(value);
        }}
      />
      <br />
      <br />
      <SchemaComponent key={collection} schema={schema} />
    </div>
  );
};

const Demo = () => {
  return (
    <SchemaComponentProvider components={{ Input, Filter }}>
      <SwitchCollection />
    </SchemaComponentProvider>
  );
};

export default Demo;
