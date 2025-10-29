import { defineCollection } from '@tego/server';

export default defineCollection({
  origin: '@tachybase/module-user',
  dumpRules: {
    group: 'user',
  },
  name: 'users',
  title: '{{t("Users")}}',
  sortable: 'sort',
  model: 'UserModel',
  createdBy: true,
  updatedBy: true,
  logging: true,
  shared: true,
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
      uiSchema: { type: 'number', title: '{{t("ID")}}', 'x-component': 'InputNumber', 'x-read-pretty': true },
      interface: 'id',
    },
    {
      interface: 'input',
      type: 'string',
      name: 'nickname',
      uiSchema: {
        type: 'string',
        title: '{{t("Nickname")}}',
        'x-component': 'Input',
      },
    },
    {
      interface: 'input',
      type: 'string',
      name: 'username',
      unique: true,
      uiSchema: {
        type: 'string',
        title: '{{t("Username")}}',
        'x-component': 'Input',
        'x-validator': { username: true },
        required: true,
      },
    },
    {
      interface: 'email',
      type: 'string',
      name: 'email',
      unique: true,
      uiSchema: {
        type: 'string',
        title: '{{t("Email")}}',
        'x-component': 'Input',
        'x-validator': 'email',
        required: true,
      },
    },
    {
      interface: 'phone',
      type: 'string',
      name: 'phone',
      unique: true,
      uiSchema: {
        type: 'string',
        title: '{{t("Phone")}}',
        'x-component': 'Input',
        'x-validator': 'phone',
        required: true,
      },
    },
    {
      interface: 'password',
      type: 'password',
      name: 'password',
      hidden: true,
      uiSchema: {
        type: 'string',
        title: '{{t("Password")}}',
        'x-component': 'Password',
      },
    },
    {
      type: 'string',
      name: 'appLang',
    },
    {
      type: 'string',
      name: 'resetToken',
      unique: true,
      hidden: true,
    },
    {
      type: 'json',
      name: 'systemSettings',
      defaultValue: {},
    },
    {
      type: 'string',
      name: 'specialRole',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'active',
      comment: '用户状态：active-正常, pending-待审核, locked-锁定, disabled-停用',
      uiSchema: {
        type: 'string',
        title: '{{t("Status")}}',
        'x-component': 'Select',
        'x-component-props': {
          fieldNames: {
            label: 'title',
            value: 'key',
          },
        },
      },
    },
    {
      type: 'date',
      name: 'statusExpireAt',
      comment: '状态过期时间，null表示永久',
      uiSchema: {
        type: 'string',
        title: '{{t("Status Expire At")}}',
        'x-component': 'DatePicker',
        'x-component-props': {
          showTime: true,
        },
      },
    },
    {
      type: 'string',
      name: 'previousStatus',
      comment: '原状态，用于状态过期后自动恢复',
      uiSchema: {
        type: 'string',
        title: '{{t("Previous Status")}}',
        'x-component': 'Select',
        'x-component-props': {
          fieldNames: {
            label: 'title',
            value: 'key',
          },
        },
      },
    },
    {
      type: 'text',
      name: 'statusReason',
      comment: '状态变更原因说明',
      uiSchema: {
        type: 'string',
        title: '{{t("Status Reason")}}',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'belongsTo',
      name: 'statusInfo',
      target: 'userStatuses',
      foreignKey: 'status',
      targetKey: 'key',
      uiSchema: {
        type: 'object',
        title: '{{t("Status")}}',
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
      name: 'previousStatusInfo',
      target: 'userStatuses',
      foreignKey: 'previousStatus',
      targetKey: 'key',
      uiSchema: {
        type: 'object',
        title: '{{t("Previous Status")}}',
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
      type: 'hasMany',
      name: 'statusHistories',
      target: 'userStatusHistories',
      foreignKey: 'userId',
      uiSchema: {
        type: 'array',
        title: '{{t("Status History")}}',
        'x-component': 'AssociationField',
      },
    },
  ],
});
