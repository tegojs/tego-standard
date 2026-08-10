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

export default class AddTenantFieldsToAuditLogsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'auditLogs';
    const tableName = getPhysicalTableName(this.db, collectionName);

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);
    const columns = [
      ['tenantId', DataTypes.STRING],
      ['actorUserId', DataTypes.STRING],
      ['impersonatedTenantId', DataTypes.STRING],
      ['tenantContextSource', DataTypes.STRING],
      ['isTenantImpersonation', DataTypes.BOOLEAN],
    ] as const;

    for (const [attributeName, type] of columns) {
      const columnName = getPhysicalColumnName(this.db, collectionName, attributeName);
      if (!table[columnName]) {
        await queryInterface.addColumn(tableName, columnName, {
          type,
          allowNull: true,
        });
      }
    }

    await addIndexIfMissing(
      queryInterface,
      tableName,
      getPhysicalColumnName(this.db, collectionName, 'tenantId'),
      'audit_logs_tenant_id',
    );
    await addIndexIfMissing(
      queryInterface,
      tableName,
      getPhysicalColumnName(this.db, collectionName, 'actorUserId'),
      'audit_logs_actor_user_id',
    );
    await addIndexIfMissing(
      queryInterface,
      tableName,
      getPhysicalColumnName(this.db, collectionName, 'impersonatedTenantId'),
      'audit_logs_impersonated_tenant_id',
    );
  }
}
