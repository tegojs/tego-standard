import { DataTypes, Migration, snakeCase } from '@tego/server';

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

export default class AddExecutionOriginMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.33';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'executions';
    const tableName = getPhysicalTableName(this.db, collectionName);
    const columnName = getPhysicalColumnName(this.db, collectionName, 'executionOrigin');

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);
    if (!table[columnName]) {
      await queryInterface.addColumn(tableName, columnName, {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }
  }

  async down() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'executions';
    const tableName = getPhysicalTableName(this.db, collectionName);
    const columnName = getPhysicalColumnName(this.db, collectionName, 'executionOrigin');

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);
    if (table[columnName]) {
      await queryInterface.removeColumn(tableName, columnName);
    }
  }
}
