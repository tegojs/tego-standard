import { DataTypes, Migration } from '@tego/server';

function normalizeTableName(table: any) {
  return typeof table === 'string' ? table : table?.tableName || table?.name;
}

async function hasTable(queryInterface: any, tableName: string) {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
}

async function addIndexIfMissing(queryInterface: any, tableName: string, columnName: string, indexName: string) {
  const indexes = await queryInterface.showIndex(tableName);
  const exists = indexes.some((index) => index.name === indexName);

  if (!exists) {
    await queryInterface.addIndex(tableName, [columnName], { name: indexName });
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
  }
}
