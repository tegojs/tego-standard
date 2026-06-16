/**
 * title: Markdown.Void
 */
import React from 'react';
import { observer, useField, useFieldSchema } from '@tachybase/schema';

import { Button } from 'antd';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Markdown } from '../Markdown';

const TestFormItem = ({ children }) => {
  const schema = useFieldSchema();
  return (
    <label>
      <span>{schema.title}</span>
      {children}
    </label>
  );
};

const schema = {
  type: 'object',
  properties: {
    markdown: {
      type: 'void',
      title: `Read pretty`,
      'x-decorator': 'Editable',
      'x-component': 'Markdown.Void',
      'x-editable': false,
      'x-component-props': {
        content: '# Markdown content',
      },
    },
  },
};

const Editable = observer(
  (props: any) => {
    const filed = useField<any>();
    if (filed.editable) {
      return props.children;
    }
    return (
      <div>
        <Button
          onClick={() => {
            filed.editable = true;
          }}
        >
          编辑
        </Button>
        <div>{props.children}</div>
      </div>
    );
  },
  { displayName: 'Editable' },
);

export default () => {
  return (
    <SchemaComponentProvider components={{ Editable, Markdown, FormItem: TestFormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
