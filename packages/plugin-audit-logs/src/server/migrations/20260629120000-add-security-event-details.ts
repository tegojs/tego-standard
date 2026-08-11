import { DataTypes, Migration } from '@tego/server';

function normalizeTableName(table: any) {
  return typeof table === 'string' ? table : table?.tableName || table?.name;
}

async function hasTable(queryInterface: any, tableName: string) {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
}

export default class AddSecurityEventDetailsToAuditLogsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.24';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = 'auditLogs';

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);

    if (!table.details) {
      await queryInterface.addColumn(tableName, 'details', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }
  }
}
