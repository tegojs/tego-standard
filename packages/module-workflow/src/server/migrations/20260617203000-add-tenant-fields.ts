import { DataTypes, Migration } from '@tego/server';

function normalizeTableName(table: any) {
  return typeof table === 'string' ? table : table?.tableName || table?.name;
}

async function hasTable(queryInterface: any, tableName: string) {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
}

async function addIndexIfMissing(
  queryInterface: any,
  tableName: string,
  columnNames: string | string[],
  indexName: string,
) {
  const indexes = await queryInterface.showIndex(tableName);
  const targetColumns = Array.isArray(columnNames) ? columnNames : [columnNames];
  const exists = indexes.some((index) => {
    const fields = (index.fields || []).map((field: any) => field.attribute || field.name).filter(Boolean);
    return (
      index.name === indexName ||
      (fields.length === targetColumns.length &&
        fields.every((field: string, index: number) => field === targetColumns[index]))
    );
  });

  if (!exists) {
    await queryInterface.addIndex(tableName, targetColumns, {
      name: indexName,
    });
  }
}

export default class AddTenantFieldsToExecutionsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = 'executions';

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);

    if (!table.tenantId) {
      await queryInterface.addColumn(tableName, 'tenantId', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    if (!table.tenantContext) {
      await queryInterface.addColumn(tableName, 'tenantContext', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }

    if (!table.authContext) {
      await queryInterface.addColumn(tableName, 'authContext', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }

    await addIndexIfMissing(queryInterface, tableName, 'tenantId', 'executions_tenant_id');
    await addIndexIfMissing(
      queryInterface,
      tableName,
      ['tenantId', 'key', 'createdAt'],
      'executions_tenant_key_created_at',
    );
  }
}
