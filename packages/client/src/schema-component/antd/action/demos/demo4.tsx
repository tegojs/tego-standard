import React from 'react';
import { Action, SchemaComponent, SchemaComponentProvider } from '@tachybase/client';
import { ISchema, observer } from '@tachybase/schema';

const schema: ISchema = {
  type: 'object',
  properties: {
    action1: {
      'x-component': 'Action',
      'x-component-props': {
        type: 'primary',
        popover: true,
        openMode: 'popover',
      },
      type: 'void',
      title: 'Open',
      properties: {
        popover: {
          type: 'void',
          'x-component': 'Action.Popover',
          properties: {
            hello: {
              type: 'void',
              'x-content': 'Hello',
            },
          },
        },
      },
    },
  },
};

export default observer(() => {
  return (
    <SchemaComponentProvider components={{ Action }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
});
