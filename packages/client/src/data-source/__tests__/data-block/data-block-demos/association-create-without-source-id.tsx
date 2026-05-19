import React from 'react';
import {
  SchemaComponent,
  useCollectionParentRecordData,
  UseDataBlockProps,
  withDynamicSchemaProps,
} from '@tachybase/client';
import { ISchema } from '@tachybase/schema';

import { createApp } from './createApp';

const collection = 'users';
const associationField = 'roles';
const association = `${collection}.${associationField}`;

const schema: ISchema = {
  type: 'void',
  name: 'root',
  'x-decorator': 'DataBlockProvider',
  'x-use-decorator-props': 'useBlockDecoratorProps',
  'x-decorator-props': {
    association,
  },
  'x-component': 'CardItem',
  properties: {
    demo: {
      type: 'void',
      'x-component': 'ParentRecordViewer',
    },
  },
};

const ParentRecordViewer = withDynamicSchemaProps(() => {
  const parentRecord = useCollectionParentRecordData<{ id?: number; username?: string }>();
  return <div data-testid="parent-record">{parentRecord?.username ?? 'no parent'}</div>;
});

const useBlockDecoratorProps: UseDataBlockProps<'AssociationCreate'> = () => {
  return {};
};

const Demo = () => {
  return <SchemaComponent schema={schema}></SchemaComponent>;
};

const Root = createApp(
  Demo,
  {
    components: { ParentRecordViewer },
    scopes: { useBlockDecoratorProps },
  },
  {
    [`${collection}:get?filter[id]=undefined`]: {
      id: 999,
      username: 'Unexpected parent',
    },
  },
);

export default Root;
