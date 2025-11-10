import { Migration } from '@tego/server';

export default class AddUserStatusFieldsMigration extends Migration {
  appVersion = '<1.4.0';

  async up() {
    const Field = this.context.db.getRepository('fields');

    // 添加用户状态字段
    const statusFieldExists = await Field.count({
      filter: {
        name: 'status',
        collectionName: 'users',
      },
    });
    if (!statusFieldExists) {
      await Field.create({
        values: {
          name: 'status',
          collectionName: 'users',
          type: 'string',
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
      });
    }

    // 添加状态过期时间字段
    const statusExpireAtFieldExists = await Field.count({
      filter: {
        name: 'statusExpireAt',
        collectionName: 'users',
      },
    });
    if (!statusExpireAtFieldExists) {
      await Field.create({
        values: {
          name: 'statusExpireAt',
          collectionName: 'users',
          type: 'date',
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
      });
    }

    // 添加原状态字段
    const previousStatusFieldExists = await Field.count({
      filter: {
        name: 'previousStatus',
        collectionName: 'users',
      },
    });
    if (!previousStatusFieldExists) {
      await Field.create({
        values: {
          name: 'previousStatus',
          collectionName: 'users',
          type: 'string',
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
      });
    }

    // 添加状态变更原因字段
    const statusReasonFieldExists = await Field.count({
      filter: {
        name: 'statusReason',
        collectionName: 'users',
      },
    });
    if (!statusReasonFieldExists) {
      await Field.create({
        values: {
          name: 'statusReason',
          collectionName: 'users',
          type: 'text',
          comment: '状态变更原因说明',
          uiSchema: {
            type: 'string',
            title: '{{t("Status Reason")}}',
            'x-component': 'Input.TextArea',
          },
        },
      });
    }

    // 添加状态信息关联字段 (belongsTo userStatuses)
    const statusInfoFieldExists = await Field.count({
      filter: {
        name: 'statusInfo',
        collectionName: 'users',
      },
    });
    if (!statusInfoFieldExists) {
      await Field.create({
        values: {
          name: 'statusInfo',
          collectionName: 'users',
          type: 'belongsTo',
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
      });
    }

    // 添加原状态信息关联字段 (belongsTo userStatuses)
    const previousStatusInfoFieldExists = await Field.count({
      filter: {
        name: 'previousStatusInfo',
        collectionName: 'users',
      },
    });
    if (!previousStatusInfoFieldExists) {
      await Field.create({
        values: {
          name: 'previousStatusInfo',
          collectionName: 'users',
          type: 'belongsTo',
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
      });
    }

    // 添加状态历史关联字段 (hasMany userStatusHistories)
    const statusHistoriesFieldExists = await Field.count({
      filter: {
        name: 'statusHistories',
        collectionName: 'users',
      },
    });
    if (!statusHistoriesFieldExists) {
      await Field.create({
        values: {
          name: 'statusHistories',
          collectionName: 'users',
          type: 'hasMany',
          target: 'userStatusHistories',
          foreignKey: 'userId',
          uiSchema: {
            type: 'array',
            title: '{{t("Status History")}}',
            'x-component': 'AssociationField',
          },
        },
      });
    }
  }

  async down() {
    const Field = this.context.db.getRepository('fields');

    // 删除添加的字段
    const fieldsToRemove = [
      'status',
      'statusExpireAt',
      'previousStatus',
      'statusReason',
      'statusInfo',
      'previousStatusInfo',
      'statusHistories',
    ];

    for (const fieldName of fieldsToRemove) {
      await Field.destroy({
        filter: {
          name: fieldName,
          collectionName: 'users',
        },
      });
    }
  }
}
