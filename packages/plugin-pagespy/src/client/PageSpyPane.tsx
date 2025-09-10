import { SchemaComponent, useAPIClient, useRequest } from '@tachybase/client';
import { createForm, ISchema, useForm } from '@tachybase/schema';

import { App, Card } from 'antd';
import { cloneDeep } from 'lodash';

import { lang, useTranslation } from './locale';
import { usePageSpy } from './PageSpyProvider';

const usePageSpyValues = () => {
  const api = useAPIClient();
  const { data } = useRequest(() =>
    api
      .resource('pagespy')
      .get()
      .then((res) => res.data?.data),
  );
  const form = createForm({
    values: data,
  });
  return { form };
};

const useSavePageSpyValues = () => {
  const form = useForm();
  const { message } = App.useApp();
  const api = useAPIClient();
  const { t } = useTranslation();
  const { refresh } = usePageSpy();
  return {
    async onClick() {
      await form.submit();
      const values = cloneDeep(form.values);
      try {
        await api.resource('pagespy').update({
          filterByTk: {
            id: 1,
          },
          values,
        });
        refresh();
        message.success(t('Saved successfully'));
      } catch (error) {
        message.error(t('Failed to save settings'));
        throw error;
      }
    },
  };
};

const schema: ISchema = {
  type: 'object',
  properties: {
    pagespy: {
      'x-component': 'FormV2',
      'x-use-component-props': 'usePageSpyValues',
      type: 'void',
      title: '{{t("PageSpy configs")}}',
      properties: {
        api: {
          type: 'string',
          title: "{{t('API')}}",
          'x-decorator': 'FormItem',
          'x-component': 'Input',
        },
        project: {
          type: 'string',
          title: lang('Project name'),
          'x-decorator': 'FormItem',
          'x-component': 'Input',
        },
        title: {
          type: 'string',
          title: "{{t('Title')}}",
          'x-decorator': 'FormItem',
          'x-component': 'Input',
        },
        footer: {
          type: 'void',
          'x-component': 'ActionBar',
          properties: {
            submit: {
              title: '{{t("Submit")}}',
              'x-component': 'Action',
              'x-component-props': {
                type: 'primary',
              },
              'x-use-component-props': 'useSavePageSpyValues',
            },
          },
        },
      },
    },
  },
};

export const PageSpyPane = () => {
  return (
    <Card bordered={false}>
      <SchemaComponent schema={schema} scope={{ usePageSpyValues, useSavePageSpyValues }} />
    </Card>
  );
};
