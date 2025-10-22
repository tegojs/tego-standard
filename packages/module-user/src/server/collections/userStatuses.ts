import { defineCollection } from '@tego/server';

export default defineCollection({
  origin: '@tachybase/module-user',
  dumpRules: {
    group: 'user',
  },
  name: 'userStatuses',
  title: '{{t("User Statuses")}}',
  sortable: 'sort',
  fields: [
    {
      type: 'string',
      name: 'key',
      primaryKey: true,
      allowNull: false,
      unique: true,
      comment: '状态唯一标识',
      uiSchema: {
        type: 'string',
        title: '{{t("Status Key")}}',
        'x-component': 'Input',
        required: true,
      },
    },
    {
      type: 'string',
      name: 'title',
      allowNull: false,
      comment: '状态显示名称',
      uiSchema: {
        type: 'string',
        title: '{{t("Status Title")}}',
        'x-component': 'Input',
        required: true,
      },
    },
    {
      type: 'string',
      name: 'color',
      defaultValue: 'default',
      comment: '状态标识颜色',
      uiSchema: {
        type: 'string',
        title: '{{t("Color")}}',
        'x-component': 'ColorPicker',
      },
    },
    {
      type: 'boolean',
      name: 'allowLogin',
      defaultValue: true,
      allowNull: false,
      comment: '是否允许登录',
      uiSchema: {
        type: 'boolean',
        title: '{{t("Allow Login")}}',
        'x-component': 'Checkbox',
      },
    },
    {
      type: 'text',
      name: 'loginErrorMessage',
      comment: '不允许登录时的错误提示信息',
      uiSchema: {
        type: 'string',
        title: '{{t("Login Error Message")}}',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'boolean',
      name: 'isSystemDefined',
      defaultValue: false,
      allowNull: false,
      comment: '是否系统内置（不可删除）',
      uiSchema: {
        type: 'boolean',
        title: '{{t("System Defined")}}',
        'x-component': 'Checkbox',
        'x-read-pretty': true,
      },
    },
    {
      type: 'integer',
      name: 'sort',
      defaultValue: 0,
      comment: '排序权重',
      uiSchema: {
        type: 'number',
        title: '{{t("Sort")}}',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'string',
      name: 'packageName',
      comment: '定义该状态的插件包名，系统内置为@tachybase/module-user',
      uiSchema: {
        type: 'string',
        title: '{{t("Package Name")}}',
        'x-component': 'Input',
        'x-read-pretty': true,
      },
    },
    {
      type: 'text',
      name: 'description',
      comment: '状态描述说明',
      uiSchema: {
        type: 'string',
        title: '{{t("Description")}}',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'json',
      name: 'config',
      defaultValue: {},
      comment: '扩展配置项',
    },
  ],
});
