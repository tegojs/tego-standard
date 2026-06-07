/**
 * title: DatePicker.RangePicker
 */
import React from 'react';
import { useField } from '@tachybase/schema';

import dayjs from 'dayjs';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Input } from '../../input/Input';
import { DatePicker } from '../DatePicker';

const FormItem = ({ children }) => {
  const field = useField();
  return (
    <div>
      {field?.title && <label>{field.title}</label>}
      {children}
    </div>
  );
};

const schema = {
  type: 'object',
  properties: {
    input: {
      type: 'boolean',
      title: `Editable`,
      'x-decorator': 'FormItem',
      'x-component': 'DatePicker.RangePicker',
      'x-component-props': {
        gmt: false,
        defaultPickerValue: [dayjs('2023-05-01')],
      },
      'x-reactions': [
        {
          target: 'read1',
          fulfill: {
            state: {
              value: '{{$self.value}}',
            },
          },
        },
        {
          target: 'read2',
          fulfill: {
            state: {
              value: '{{$self.value && $self.value.join(" ~ ")}}',
            },
          },
        },
      ],
    },
    read1: {
      type: 'boolean',
      title: `Read pretty`,
      'x-read-pretty': true,
      'x-decorator': 'FormItem',
      'x-component': 'DatePicker.RangePicker',
      'x-component-props': {
        defaultPickerValue: [dayjs('2023-05-01')],
      },
    },
    read2: {
      type: 'string',
      title: `Value`,
      'x-read-pretty': true,
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      'x-component-props': {},
    },
  },
};

export default () => {
  return (
    <SchemaComponentProvider components={{ Input, DatePicker, FormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>
  );
};
