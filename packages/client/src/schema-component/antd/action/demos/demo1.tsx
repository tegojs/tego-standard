import React from 'react';
import { Action, SchemaComponent, SchemaComponentProvider, useActionContext } from '@tachybase/client';
import { ISchema, observer } from '@tachybase/schema';

const useCloseAction = () => {
  const { setVisible } = useActionContext();
  return {
    async run() {
      setVisible(false);
    },
  };
};

const schema: ISchema = {
  type: 'object',
  properties: {
    action1: {
      'x-component': 'Action',
      'x-component-props': {
        type: 'primary',
      },
      type: 'void',
      title: 'Open',
      properties: {
        drawer1: {
          'x-component': 'Action.Drawer',
          type: 'void',
          title: 'Drawer Title',
          properties: {
            hello1: {
              'x-content': 'Hello',
              title: 'T1',
            },
            footer1: {
              'x-component': 'Action.Drawer.Footer',
              type: 'void',
              properties: {
                close1: {
                  title: 'Close',
                  'x-component': 'Action',
                  'x-component-props': {
                    useAction: '{{ useCloseAction }}',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export default observer(() => {
  return (
    <SchemaComponentProvider scope={{ useCloseAction }} components={{ Action }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
});
