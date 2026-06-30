import { DataTypes, Migration } from '@tego/server';

import { COLLECTION_NAME_APPROVAL_CARBON_COPY } from '../../common/constants';

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

export default class AddTenantFieldsToWorkflowApprovalMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableNames = ['approvals', 'approvalRecords', 'approvalExecutions', COLLECTION_NAME_APPROVAL_CARBON_COPY];

    for (const tableName of tableNames) {
      if (!(await hasTable(queryInterface, tableName))) {
        this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
        continue;
      }

      const table = await queryInterface.describeTable(tableName);

      if (!table.tenantId) {
        await queryInterface.addColumn(tableName, 'tenantId', {
          type: DataTypes.STRING,
          allowNull: true,
        });
      }

      await addIndexIfMissing(queryInterface, tableName, 'tenantId', `${tableName}_tenant_id`);
    }
  }
}
