import React from 'react';
import { ISchema, uid } from '@tachybase/schema';

import { SchemaComponent } from '../../../../schema-component/core/SchemaComponent';
import { SchemaComponentProvider } from '../../../../schema-component/core/SchemaComponentProvider';
import { Input } from '../../input/Input';
import { Grid } from '../Grid';

const schema: ISchema = {
  type: 'void',
  name: 'grid1',
  'x-component': 'Grid',
  'x-uid': uid(),
  properties: {
    row1: {
      type: 'void',
      'x-component': 'Grid.Row',
      'x-uid': uid(),
      properties: {
        col11: {
          type: 'void',
          'x-component': 'Grid.Col',
          properties: {
            name: {
              type: 'string',
              title: 'Name',
              'x-component': 'Input',
              'x-collection-field': 'posts.name',
            },
            title: {
              type: 'string',
              title: 'Title',
              'x-component': 'Input',
              'x-collection-field': 'posts.title',
            },
          },
        },
        col12: {
          type: 'void',
          'x-component': 'Grid.Col',
          properties: {
            intro: {
              type: 'string',
              title: 'Intro',
              'x-component': 'Input',
            },
          },
        },
      },
    },
  },
};

const Root = () => {
  return (
    <SchemaComponentProvider components={{ Grid, Input }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};

export default function App() {
  return <Root />;
}
