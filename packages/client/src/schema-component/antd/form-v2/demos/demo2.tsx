import React from 'react';
import { ISchema, useField, useForm } from '@tachybase/schema';

import { Form as AntdForm, Button, notification } from 'antd';

import { SchemaComponent } from '../../../../schema-component/core/SchemaComponent';
import { SchemaComponentProvider } from '../../../../schema-component/core/SchemaComponentProvider';
import { Input } from '../../input/Input';
import { Form as FormV2 } from '../Form';

const FormItem = (props) => {
  const field = useField();
  return <AntdForm.Item label={field.title}>{props.children}</AntdForm.Item>;
};

const SubmitButton = () => {
  const form = useForm();
  return (
    <Button
      type="primary"
      onClick={() => {
        notification.success({ message: JSON.stringify(form.values) });
      }}
    >
      Submit
    </Button>
  );
};

const schema: ISchema = {
  type: 'object',
  properties: {
    form: {
      type: 'void',
      'x-component': 'FormV2',
      'x-component-props': {
        initialValues: {
          nickname: '张三',
          password: '123456',
        },
      },
      properties: {
        nickname: {
          type: 'string',
          title: 'Nickname',
          'x-decorator': 'FormItem',
          'x-component': 'Input',
          'x-component-props': {
            className: 'nickname',
          },
        },
        password: {
          type: 'string',
          title: 'Password',
          'x-decorator': 'FormItem',
          'x-component': 'Input',
          'x-component-props': {
            className: 'password',
          },
        },
        button: {
          type: 'void',
          'x-component': 'SubmitButton',
        },
      },
    },
  },
};

export default function App() {
  return (
    <SchemaComponentProvider components={{ FormV2, FormItem, Input, SubmitButton }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
}
