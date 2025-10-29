import { ISchema } from '@tachybase/schema';

export const userStatusHistoriesCollection = {
  name: 'userStatusHistories',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      primaryKey: true,
      uiSchema: {
        type: 'number',
        title: '{{t("ID")}}',
        'x-component': 'InputNumber',
        'x-read-pretty': true,
      },
    },
    {
      interface: 'm2o',
      type: 'belongsTo',
      name: 'user',
      target: 'users',
      foreignKey: 'userId',
      uiSchema: {
        type: 'object',
        title: '{{t("User")}}',
        'x-component': 'AssociationField',
        'x-component-props': {
          fieldNames: {
            label: 'nickname',
            value: 'id',
          },
        },
      },
    },
    {
      interface: 'm2o',
      type: 'belongsTo',
      name: 'fromStatusInfo',
      target: 'userStatuses',
      foreignKey: 'fromStatus',
      targetKey: 'key',
      uiSchema: {
        type: 'object',
        title: '{{t("From Status")}}',
        'x-component': 'AssociationField',
        'x-component-props': {
          fieldNames: {
            label: 'title',
            value: 'key',
          },
        },
      },
    },
    {
      interface: 'm2o',
      type: 'belongsTo',
      name: 'toStatusInfo',
      target: 'userStatuses',
      foreignKey: 'toStatus',
      targetKey: 'key',
      uiSchema: {
        type: 'object',
        title: '{{t("To Status")}}',
        'x-component': 'AssociationField',
        'x-component-props': {
          fieldNames: {
            label: 'title',
            value: 'key',
          },
        },
      },
    },
    {
      interface: 'input',
      type: 'string',
      name: 'fromStatus',
      uiSchema: {
        type: 'string',
        title: '{{t("From Status")}}',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
    {
      interface: 'input',
      type: 'string',
      name: 'toStatus',
      uiSchema: {
        type: 'string',
        title: '{{t("To Status")}}',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
    {
      interface: 'textarea',
      type: 'text',
      name: 'reason',
      uiSchema: {
        type: 'string',
        title: '{{t("Reason")}}',
        'x-component': 'Input.TextArea',
        'x-read-pretty': true,
      },
    },
    {
      interface: 'select',
      type: 'string',
      name: 'operationType',
      uiSchema: {
        type: 'string',
        title: '{{t("Operation Type")}}',
        'x-component': 'Select',
        enum: [
          { label: '{{t("Manual")}}', value: 'manual' },
          { label: '{{t("Auto")}}', value: 'auto' },
          { label: '{{t("System")}}', value: 'system' },
        ],
        'x-read-pretty': true,
      },
    },
    {
      interface: 'datetime',
      type: 'date',
      name: 'expireAt',
      uiSchema: {
        type: 'string',
        title: '{{t("Expire At")}}',
        'x-component': 'DatePicker',
        'x-component-props': {
          showTime: true,
        },
        'x-read-pretty': true,
      },
    },
    {
      interface: 'm2o',
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
      uiSchema: {
        type: 'object',
        title: '{{t("Created By")}}',
        'x-component': 'AssociationField',
        'x-component-props': {
          fieldNames: {
            label: 'nickname',
            value: 'id',
          },
        },
      },
    },
    {
      interface: 'createdAt',
      type: 'date',
      name: 'createdAt',
      uiSchema: {
        type: 'datetime',
        title: '{{t("Created At")}}',
        'x-component': 'DatePicker',
        'x-component-props': {
          showTime: true,
        },
        'x-read-pretty': true,
      },
    },
  ],
};

export const userStatusHistoriesSchema: ISchema = {
  type: 'void',
  properties: {
    userStatusHistoriesBlock: {
      type: 'void',
      'x-decorator': 'TableBlockProvider',
      'x-component': 'CardItem',
      'x-decorator-props': {
        collection: userStatusHistoriesCollection,
        action: 'list',
        params: {
          pageSize: 50,
          sort: ['-createdAt'],
          appends: ['user', 'createdBy', 'fromStatusInfo', 'toStatusInfo'],
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
          },
        },
        table: {
          type: 'array',
          'x-uid': 'userStatusHistoriesTable',
          'x-component': 'TableV2',
          'x-use-component-props': 'useTableBlockProps',
          'x-component-props': {
            rowKey: 'id',
          },
          properties: {
            column1: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              title: '{{t("User")}}',
              properties: {
                user: {
                  type: 'object',
                  'x-component': 'UserNicknameField',
                },
              },
            },
            column2: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              title: '{{t("From Status")}}',
              properties: {
                fromStatusInfo: {
                  type: 'object',
                  'x-component': 'UserStatusField',
                },
              },
            },
            column3: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              title: '{{t("To Status")}}',
              properties: {
                toStatusInfo: {
                  type: 'object',
                  'x-component': 'UserStatusField',
                },
              },
            },
            column4: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                reason: {
                  type: 'string',
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
                operationType: {
                  type: 'string',
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
                expireAt: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column7: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              title: '{{t("Created By")}}',
              properties: {
                createdBy: {
                  type: 'object',
                  'x-component': 'UserNicknameField',
                },
              },
            },
            column8: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                createdAt: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
          },
        },
      },
    },
  },
};
