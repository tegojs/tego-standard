import React from 'react';
import { ISchema, uid } from '@tachybase/schema';

import { SchemaComponent } from '../../../../schema-component/core/SchemaComponent';
import { SchemaComponentProvider } from '../../../../schema-component/core/SchemaComponentProvider';
import { Grid } from '../Grid';

const schema: ISchema = {
  type: 'object',
  properties: {
    grid: {
      type: 'void',
      'x-component': 'Grid',
      'x-uid': uid(),
      properties: {},
    },
  },
};

function Root() {
  return (
    <SchemaComponentProvider components={{ Grid }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
}

export default function App() {
  return <Root />;
}
