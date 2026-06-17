import React from 'react';
import { ISchema, useField } from '@tachybase/schema';

import { Form as AntdForm } from 'antd';

import { SchemaComponent } from '../../../../schema-component/core/SchemaComponent';
import { SchemaComponentProvider } from '../../../../schema-component/core/SchemaComponentProvider';
import { Grid } from '../../grid/Grid';
import { Input } from '../../input/Input';
import { Password } from '../../password/Password';
import { Form as FormV2 } from '../Form';

const FormItem = (props) => {
  const field = useField();
  return <AntdForm.Item label={field.title}>{props.children}</AntdForm.Item>;
};

const schema: ISchema = {
  type: 'object',
  properties: {
    form: {
      type: 'void',
      'x-component': 'FormV2',
      'x-read-pretty': true,
      'x-component-props': {
        initialValues: {
          nickname: '张三',
          password: '123456',
        },
      },
      properties: {
        grid: {
          type: 'void',
          'x-component': 'Grid',
          properties: {
            row1: {
              type: 'void',
              'x-component': 'Grid.Row',
              properties: {
                col11: {
                  type: 'void',
                  'x-component': 'Grid.Col',
                  properties: {
                    nickname: {
                      type: 'string',
                      title: 'Nickname',
                      'x-decorator': 'FormItem',
                      'x-component': 'Input',
                    },
                  },
                },
                col12: {
                  type: 'void',
                  'x-component': 'Grid.Col',
                  properties: {
                    password: {
                      type: 'string',
                      title: 'Password',
                      'x-decorator': 'FormItem',
                      'x-component': 'Password',
                    },
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

export default function App() {
  return (
    <SchemaComponentProvider components={{ FormV2, FormItem, Grid, Input, Password }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
}
