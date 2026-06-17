import React from 'react';
import { useField } from '@tachybase/schema';

import { useTranslation } from 'react-i18next';

import { FormProvider } from '../../../core/FormProvider';
import { SchemaComponent } from '../../../core/SchemaComponent';
import { Cron } from '../Cron';

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
    cron: {
      type: 'string',
      title: 'Cron',
      'x-decorator': 'FormItem',
      'x-component': 'Cron',
    },
  },
};

export default () => {
  const { t } = useTranslation();

  return (
    <FormProvider>
      <SchemaComponent components={{ Cron, FormItem }} scope={{ t }} schema={schema} />
    </FormProvider>
  );
};
