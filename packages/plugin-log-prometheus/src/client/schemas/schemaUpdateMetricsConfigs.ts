import { ISchema } from '@tachybase/schema';

import { metricsConfigsCollection } from '../collections/metricsConfigsCollection';

export const updateMetricsConfig: ISchema = {
  type: 'void',
  title: '{{ t("Edit") }}',
  'x-action': 'update',
  'x-component': 'Action.Link',
  'x-component-props': {
    openMode: 'drawer',
    icon: 'EditOutlined',
  },
  'x-decorator': 'ACLActionProvider',
  properties: {
    drawer: {
      type: 'void',
      title: '{{ t("Edit record") }}',
      'x-component': 'Action.Container',
      'x-component-props': {
        className: 'tb-action-popup',
      },
      properties: {
        card: {
          type: 'void',
          'x-acl-action-props': {
            skipScopeCheck: false,
          },
          'x-acl-action': `${metricsConfigsCollection.name}:update`,
          'x-decorator': 'FormBlockProvider',
          'x-use-decorator-props': 'useEditFormBlockDecoratorProps',
          'x-decorator-props': {
            action: 'get',
            dataSource: 'main',
            collection: metricsConfigsCollection,
          },
          'x-component': 'CardItem',
          properties: {
            form: {
              type: 'void',
              'x-component': 'FormV2',
              'x-use-component-props': 'useEditFormBlockProps',
              properties: {
                actionBar: {
                  type: 'void',
                  'x-component': 'ActionBar',
                  'x-component-props': {
                    style: {
                      marginBottom: 24,
                    },
                  },
                  properties: {
                    cancel: {
                      title: '{{ t("Cancel") }}',
                      'x-component': 'Action',
                      'x-use-component-props': 'useCancelActionProps',
                    },
                    submit: {
                      title: '{{ t("Submit") }}',
                      'x-component': 'Action',
                      'x-use-component-props': 'useUpdateActionProps',
                      'x-component-props': {
                        type: 'primary',
                      },
                      'x-action-settings': {
                        isDeltaChanged: true,
                      },
                    },
                  },
                },
                title: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  'x-validator': `{{(value) => {
                                        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
                                            return t("Title must start with a letter or underscore, followed by letters, digits or underscores");
                                        }
                                        return true;
                                    }}}`,
                  required: true,
                },
                help: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  required: true,
                },
                type: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  required: true,
                },
                resourceName: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  required: true,
                },
                action: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  required: true,
                },
                apiConfig: {
                  type: 'boolean',
                  default: true,
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                },
                trackingOptions: {
                  type: 'json',
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  'x-component-props': {
                    style: {
                      height: '300px',
                    },
                  },
                  'x-reactions': [
                    {
                      dependencies: ['apiConfig'],
                      fulfill: {
                        state: {
                          visible: '{{!!$deps[0]}}',
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
};
