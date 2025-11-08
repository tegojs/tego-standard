import { DataTypes, Migration } from '@tego/server';

export default class AddSortToWorkflowsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.4.0';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = 'workflows';

    // 检查表是否存在
    const tables: string[] = await queryInterface.showAllTables();
    if (!tables.includes(tableName)) {
      this.app.logger.info(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    // 检查 sort 列是否已存在
    const tableDescription = await queryInterface.describeTable(tableName);
    if (tableDescription.sort) {
      this.app.logger.info(`[migration skipped] column sort already exists in ${tableName}`);
      return;
    }

    try {
      // 添加 sort 列
      // 对于所有数据库，都添加允许 NULL 的列，并设置默认值
      // SQLite 3.3.0+ 支持在添加列时设置默认值，会自动应用到现有行
      await queryInterface.addColumn(tableName, 'sort', {
        type: DataTypes.BIGINT,
        allowNull: true,
        defaultValue: 0,
      });

      // 为现有记录设置默认值（确保所有现有记录都有值）
      // 这在某些数据库或版本中可能不会自动应用默认值
      await this.db.sequelize.query(`UPDATE ${this.db.utils.quoteTable(tableName)} SET sort = 0 WHERE sort IS NULL`);

      this.app.logger.info(`[workflows] added sort column successfully`);

      // 更新 fields 表，添加字段记录（如果使用字段管理系统）
      const Field = this.context.db.getRepository('fields');
      const sortFieldExists = await Field.count({
        filter: {
          name: 'sort',
          collectionName: 'workflows',
        },
      });

      if (!sortFieldExists) {
        await Field.create({
          values: {
            name: 'sort',
            collectionName: 'workflows',
            type: 'bigInt',
            interface: 'sort',
            uiSchema: {
              type: 'number',
              title: '{{t("Sort")}}',
              'x-component': 'InputNumber',
              'x-component-props': {
                stringMode: true,
                step: '1',
              },
              'x-validator': 'integer',
            },
          },
        });
        this.app.logger.info(`[workflows] added sort field record to fields table`);
      }
    } catch (error) {
      // 如果错误是因为列已存在，则忽略
      if (
        error.message?.includes('duplicate column name') ||
        error.message?.includes('already exists') ||
        (error.message?.includes('column') && error.message?.includes('exists'))
      ) {
        this.app.logger.info(`[migration skipped] sort column may already exist: ${error.message}`);
        return;
      }
      throw error;
    }
  }
}
