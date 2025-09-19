export const sharePageConfig = {
  title: 'sharePageConfig',
  name: 'sharePageConfig',
  fields: [
    {
      name: 'createdAt',
      interface: 'createdAt',
      type: 'date',
      field: 'createdAt',
      uiSchema: {
        type: 'datetime',
        title: '{{t("Created at")}}',
        'x-component': 'DatePicker',
        'x-component-props': {},
        'x-read-pretty': true,
      },
    },
    {
      name: 'createdBy',
      interface: 'createdBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'createdById',
      uiSchema: {
        type: 'object',
        title: '{{t("Created by")}}',
        'x-component': 'AssociationField',
        'x-component-props': {
          fieldNames: {
            value: 'id',
            label: 'nickname',
          },
        },
        'x-read-pretty': true,
      },
    },
    {
      type: 'date',
      field: 'updatedAt',
      name: 'updatedAt',
      interface: 'updatedAt',
      uiSchema: {
        type: 'string',
        title: '{{t("Last updated at")}}',
        'x-component': 'DatePicker',
        'x-component-props': {},
        'x-read-pretty': true,
      },
    },
    {
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'updatedById',
      name: 'updatedBy',
      interface: 'updatedBy',
      uiSchema: {
        type: 'object',
        title: '{{t("Last updated by")}}',
        'x-component': 'AssociationField',
        'x-component-props': {
          fieldNames: {
            value: 'id',
            label: 'nickname',
          },
        },
        'x-read-pretty': true,
      },
    },
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
      interface: 'id',
      uiSchema: {
        type: 'number',
        title: '{{t("ID")}}',
        'x-component': 'InputNumber',
        'x-read-pretty': true,
      },
    },
    {
      interface: 'checkbox',
      name: 'linkStatus',
      type: 'boolean',
      uiSchema: {
        title: 'linkStatus',
        type: 'boolean',
        'x-component': 'Checkbox',
        'x-component-props': {
          shouUnchecked: true,
        },
      },
    },
    {
      type: 'password',
      name: 'password',
      interface: 'password',
      hidden: true,
      uiSchema: {
        type: 'string',
        title: '{{t("Password")}}',
        'x-component': 'Password',
      },
    },
    {
      interface: 'checkbox',
      name: 'permanent',
      type: 'boolean',
      uiSchema: {
        title: 'permanent',
        type: 'boolean',
        'x-component': 'Checkbox',
        'x-component-props': {
          shouUnchecked: false,
        },
      },
    },
    {
      interface: 'datetime',
      name: 'shareTime',
      type: 'date',
      uiSchema: {
        title: '{{t("ShareTime")}}',
        type: 'string',
        'x-component': 'DatePicker',
        'x-component-props': {
          dateFormat: 'YYYY-MM-DD',
          gmt: false,
          showTime: false,
        },
      },
    },
    {
      interface: 'radioGroup',
      name: 'permission',
      type: 'string',
      uiSchema: {
        title: '{{t("Permission")}}',
        tye: 'string',
        'x-component': 'Radio.Group',
        enum: [
          {
            value: 'edit',
            label: '{{t("Editable")}}',
            color: 'gold',
          },
          {
            value: 'view',
            label: '{{t("View Only")}}',
            color: 'green',
          },
        ],
      },
    },
    {
      interface: 'url',
      name: 'generateLink',
      type: 'text',
      uiSchema: {
        title: 'generateLink',
        tye: 'string',
        'x-component': 'Input.URL',
      },
    },
    {
      interface: 'input',
      type: 'jsonb',
      name: 'tabs',
      uiSchema: {
        type: 'object',
        title: `tabs`,
        'x-component': 'Json',
        'x-component-props': {
          style: {
            height: '100px',
          },
        },
      },
    },
  ],
};
