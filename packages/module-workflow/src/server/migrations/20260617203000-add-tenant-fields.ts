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

async function removeIndexIfExists(queryInterface: any, tableName: string, indexName: string) {
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some((index) => index.name === indexName)) {
    await queryInterface.removeIndex(tableName, indexName);
  }
}

export default class AddTenantFieldsToExecutionsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'executions';
    const tableName = getPhysicalTableName(this.db, collectionName);
    const tenantId = getPhysicalColumnName(this.db, collectionName, 'tenantId');
    const tenantContext = getPhysicalColumnName(this.db, collectionName, 'tenantContext');
    const authContext = getPhysicalColumnName(this.db, collectionName, 'authContext');
    const createdAt = getPhysicalColumnName(this.db, collectionName, 'createdAt');
    const key = getPhysicalColumnName(this.db, collectionName, 'key');

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);

    if (!table[tenantId]) {
      await queryInterface.addColumn(tableName, tenantId, {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    if (!table[tenantContext]) {
      await queryInterface.addColumn(tableName, tenantContext, {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }

    if (!table[authContext]) {
      await queryInterface.addColumn(tableName, authContext, {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }

    await addIndexIfMissing(queryInterface, tableName, tenantId, 'executions_tenant_id');
    await addIndexIfMissing(queryInterface, tableName, [tenantId, key, createdAt], 'executions_tenant_key_created_at');
  }

  async down() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'executions';
    const tableName = getPhysicalTableName(this.db, collectionName);

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    await removeIndexIfExists(queryInterface, tableName, 'executions_tenant_key_created_at');
    await removeIndexIfExists(queryInterface, tableName, 'executions_tenant_id');

    const table = await queryInterface.describeTable(tableName);
    const columnNames = ['authContext', 'tenantContext', 'tenantId'].map((attributeName) =>
      getPhysicalColumnName(this.db, collectionName, attributeName),
    );
    for (const columnName of columnNames) {
      if (table[columnName]) {
        await queryInterface.removeColumn(tableName, columnName);
      }
    }
  }
}
