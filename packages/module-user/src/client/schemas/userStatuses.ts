import { ISchema } from '@tachybase/schema';

export const userStatusCollection = {
  name: 'userStatuses',
  fields: [
    {
      name: 'key',
      type: 'string',
      primaryKey: true,
      allowNull: false,
      unique: true,
      uiSchema: {
        type: 'string',
        title: '{{t("Status Key")}}',
        'x-component': 'Input',
        required: true,
      },
    },
    {
      name: 'title',
      type: 'string',
      allowNull: false,
      uiSchema: {
        type: 'string',
        title: '{{t("Status Title")}}',
        'x-component': 'Input',
        required: true,
      },
    },
    {
      name: 'color',
      type: 'string',
      uiSchema: {
        type: 'string',
        title: '{{t("Color")}}',
        'x-component': 'ColorPicker',
      },
    },
    {
      name: 'allowLogin',
      type: 'boolean',
      defaultValue: true,
      uiSchema: {
        type: 'boolean',
        title: '{{t("Allow Login")}}',
        'x-component': 'Checkbox',
      },
    },
    {
      name: 'loginErrorMessage',
      type: 'text',
      uiSchema: {
        type: 'string',
        title: '{{t("Login Error Message")}}',
        'x-component': 'Input.TextArea',
      },
    },
    {
      name: 'isSystemDefined',
      type: 'boolean',
      defaultValue: false,
      uiSchema: {
        type: 'boolean',
        title: '{{t("System Defined")}}',
        'x-component': 'Checkbox',
        'x-read-pretty': true,
      },
    },
    {
      name: 'sort',
      type: 'integer',
      defaultValue: 0,
      uiSchema: {
        type: 'number',
        title: '{{t("Sort")}}',
        'x-component': 'InputNumber',
      },
    },
    {
      name: 'packageName',
      type: 'string',
      uiSchema: {
        type: 'string',
        title: '{{t("Package Name")}}',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
    {
      name: 'description',
      type: 'text',
      uiSchema: {
        type: 'string',
        title: '{{t("Description")}}',
        'x-component': 'Input.TextArea',
      },
    },
  ],
};

const create: ISchema = {
  type: 'void',
  'x-action': 'create',
  'x-acl-action': 'create',
  title: "{{t('Add new')}}",
  'x-component': 'Action',
  'x-decorator': 'ACLActionProvider',
  'x-component-props': {
    openMode: 'drawer',
    type: 'primary',
    component: 'CreateRecordAction',
    icon: 'PlusOutlined',
  },
  'x-align': 'right',
  'x-acl-action-props': {
    skipScopeCheck: true,
  },
  properties: {
    drawer: {
      type: 'void',
      title: '{{ t("Add status") }}',
      'x-component': 'Action.Container',
      'x-component-props': {
        className: 'tb-action-popup',
      },
      properties: {
        body: {
          type: 'void',
          'x-acl-action-props': {
            skipScopeCheck: true,
          },
          'x-acl-action': `userStatuses:create`,
          'x-decorator': 'FormBlockProvider',
          'x-use-decorator-props': 'useCreateFormBlockDecoratorProps',
          'x-decorator-props': {
            dataSource: 'main',
            collection: userStatusCollection,
          },
          'x-component': 'CardItem',
          properties: {
            form: {
              type: 'void',
              'x-component': 'FormV2',
              'x-use-component-props': 'useCreateFormBlockProps',
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
                      'x-use-component-props': 'useCreateActionProps',
                      'x-component-props': {
                        type: 'primary',
                        htmlType: 'submit',
                      },
                      'x-action-settings': {
                        assignedValues: {},
                        triggerWorkflows: [],
                        pageMode: false,
                      },
                    },
                  },
                },
                key: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  required: true,
                },
                title: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                  required: true,
                },
                color: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                },
                allowLogin: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                },
                loginErrorMessage: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                },
                sort: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                },
                description: {
                  'x-component': 'CollectionField',
                  'x-decorator': 'FormItem',
                },
              },
            },
          },
        },
      },
    },
  },
};

export const userStatusesSchema: ISchema = {
  type: 'void',
  properties: {
    userStatusesBlock: {
      type: 'void',
      'x-decorator': 'TableBlockProvider',
      'x-component': 'CardItem',
      'x-decorator-props': {
        collection: userStatusCollection,
        action: 'list',
        params: {
          pageSize: 50,
          sort: ['sort'],
        },
      },
      properties: {
        actions: {
          type: 'void',
          'x-component': 'ActionBar',
          'x-component-props': {
            style: {
              marginBottom: 16,
            },
          },
          properties: {
            filter: {
              type: 'void',
              title: '{{ t("Filter") }}',
              'x-action': 'filter',
              'x-component': 'Filter.Action',
              'x-use-component-props': 'useFilterActionProps',
              'x-component-props': {
                icon: 'FilterOutlined',
              },
              'x-align': 'left',
            },
            delete: {
              type: 'void',
              title: '{{ t("Delete") }}',
              'x-component': 'Action',
              'x-use-component-props': 'useBulkDestroyActionProps',
              'x-component-props': {
                confirm: {
                  title: "{{t('Delete statuses')}}",
                  content: "{{t('Are you sure you want to delete it?')}}",
                },
                icon: 'DeleteOutlined',
              },
            },
            create,
          },
        },
        table: {
          type: 'array',
          'x-uid': 'userStatusesTable',
          'x-component': 'TableV2',
          'x-use-component-props': 'useTableBlockProps',
          'x-component-props': {
            rowKey: 'key',
            rowSelection: {
              type: 'checkbox',
            },
          },
          properties: {
            column1: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                key: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column2: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                title: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column3: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                color: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column4: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                allowLogin: {
                  type: 'boolean',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column5: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                isSystemDefined: {
                  type: 'boolean',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column6: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                sort: {
                  type: 'number',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column7: {
              type: 'void',
              title: '{{t("Actions")}}',
              'x-component': 'TableV2.Column',
              properties: {
                actions: {
                  type: 'void',
                  'x-component': 'Space',
                  properties: {
                    update: {
                      type: 'void',
                      title: '{{t("Edit")}}',
                      'x-acl-action-props': {
                        skipScopeCheck: false,
                      },
                      'x-acl-action': 'userStatuses:update',
                      'x-decorator': 'FormBlockProvider',
                      'x-use-decorator-props': 'useEditFormBlockDecoratorProps',
                      'x-decorator-props': {
                        action: 'get',
                        dataSource: 'main',
                        collection: 'userStatuses',
                      },
                      'x-component': 'Action.Link',
                      'x-component-props': {
                        type: 'primary',
                      },
                      properties: {
                        drawer: {
                          type: 'void',
                          'x-component': 'Action.Drawer',
                          'x-decorator': 'FormV2',
                          'x-use-decorator-props': 'useEditFormBlockProps',
                          title: '{{t("Edit status")}}',
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
                                },
                              },
                            },
                            key: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                              'x-disabled': true,
                            },
                            title: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                              required: true,
                            },
                            color: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                            },
                            allowLogin: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                            },
                            loginErrorMessage: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                            },
                            sort: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                            },
                            description: {
                              'x-component': 'CollectionField',
                              'x-decorator': 'FormItem',
                            },
                          },
                        },
                      },
                    },
                    delete: {
                      type: 'void',
                      title: '{{ t("Delete") }}',
                      'x-acl-action': 'userStatuses:destroy',
                      'x-action': 'destroy',
                      'x-decorator': 'ACLActionProvider',
                      'x-component': 'Action.Link',
                      'x-use-component-props': 'useDestroyActionProps',
                      'x-component-props': {
                        confirm: {
                          title: "{{t('Delete')}}",
                          content: "{{t('Are you sure you want to delete it?')}}",
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
    },
  },
};
