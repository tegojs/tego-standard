import { defineCollection } from '@tego/server';

export default defineCollection({
  origin: '@tachybase/module-user',
  dumpRules: {
    group: 'log',
  },
  name: 'userStatusHistories',
  title: '{{t("User Status Histories")}}',
  createdAt: true,
  createdBy: true,
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
      uiSchema: {
        type: 'number',
        title: '{{t("ID")}}',
        'x-component': 'InputNumber',
        'x-read-pretty': true,
      },
    },
    {
      type: 'bigInt',
      name: 'userId',
      allowNull: false,
      comment: '用户ID',
      uiSchema: {
        type: 'number',
        title: '{{t("User ID")}}',
        'x-component': 'InputNumber',
        'x-read-pretty': true,
      },
    },
    {
      type: 'string',
      name: 'fromStatus',
      comment: '变更前状态',
      uiSchema: {
        type: 'string',
        title: '{{t("From Status")}}',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
    {
      type: 'string',
      name: 'toStatus',
      allowNull: false,
      comment: '变更后状态',
      uiSchema: {
        type: 'string',
        title: '{{t("To Status")}}',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
    {
      type: 'text',
      name: 'reason',
      comment: '变更原因',
      uiSchema: {
        type: 'string',
        title: '{{t("Reason")}}',
        'x-component': 'Input.TextArea',
        'x-read-pretty': true,
      },
    },
    {
      type: 'date',
      name: 'expireAt',
      comment: '设置的过期时间（如有）',
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
      type: 'string',
      name: 'operationType',
      defaultValue: 'manual',
      allowNull: false,
      comment: '操作类型：manual-手动, auto-自动, system-系统',
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
      type: 'belongsTo',
      name: 'user',
      target: 'users',
      foreignKey: 'userId',
      onDelete: 'CASCADE',
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
  ],
});
