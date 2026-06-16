import React, { useState } from 'react';
import {
  Action,
  ActionContextProvider,
  SchemaComponent,
  SchemaComponentProvider,
  useActionContext,
} from '@tachybase/client';
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
};

export default observer(() => {
  const [visible, setVisible] = useState(false);
  return (
    <SchemaComponentProvider components={{ Action }}>
      <ActionContextProvider value={{ visible, setVisible }}>
        <a onClick={() => setVisible(true)}>Open</a>
        <SchemaComponent scope={{ useCloseAction }} schema={schema} />
      </ActionContextProvider>
    </SchemaComponentProvider>
  );
});
