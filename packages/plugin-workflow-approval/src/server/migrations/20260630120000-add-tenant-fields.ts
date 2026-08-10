import { DataTypes, Migration, snakeCase } from '@tego/server';

import { COLLECTION_NAME_APPROVAL_CARBON_COPY } from '../../common/constants';

function normalizeTableName(table: any) {
  return typeof table === 'string' ? table : table?.tableName || table?.name;
}

function getModel(db: any, collectionName: string) {
  try {
    return db.getCollection?.(collectionName)?.model || db.getModel?.(collectionName) || null;
  } catch {
    return null;
  }
}

function getPhysicalTableName(db: any, collectionName: string) {
  const model = getModel(db, collectionName);
  const modelTableName = normalizeTableName(model?.getTableName?.() || model?.tableName);
  return modelTableName || (db.options?.underscored ? snakeCase(collectionName) : collectionName);
}

function getPhysicalColumnName(db: any, collectionName: string, attributeName: string) {
  const model = getModel(db, collectionName);
  const attribute = model?.getAttributes?.()?.[attributeName] || model?.rawAttributes?.[attributeName];
  return attribute?.field || (db.options?.underscored ? snakeCase(attributeName) : attributeName);
}

async function hasTable(queryInterface: any, tableName: string) {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
}

async function addIndexIfMissing(queryInterface: any, tableName: string, columnName: string, indexName: string) {
  const indexes = await queryInterface.showIndex(tableName);
  const exists = indexes.some((index) => {
    const fields = (index.fields || []).map((field: any) => field.attribute || field.name).filter(Boolean);
    return index.name === indexName || (fields.length === 1 && fields[0] === columnName);
  });

  if (!exists) {
    await queryInterface.addIndex(tableName, [columnName], { name: indexName });
  }
}

export default class AddTenantFieldsToWorkflowApprovalMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionNames = [
      'approvals',
      'approvalRecords',
      'approvalExecutions',
      COLLECTION_NAME_APPROVAL_CARBON_COPY,
    ];

    for (const collectionName of collectionNames) {
      const tableName = getPhysicalTableName(this.db, collectionName);
      if (!(await hasTable(queryInterface, tableName))) {
        this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
        continue;
      }

      const table = await queryInterface.describeTable(tableName);
      const tenantId = getPhysicalColumnName(this.db, collectionName, 'tenantId');

      if (!table[tenantId]) {
        await queryInterface.addColumn(tableName, tenantId, {
          type: DataTypes.STRING,
          allowNull: true,
        });
      }

      await addIndexIfMissing(queryInterface, tableName, tenantId, `${tableName}_tenant_id`);
    }
  }
}
