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
    const tableName = 'auditLogs';

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    const table = await queryInterface.describeTable(tableName);
    const columns = {
      tenantId: DataTypes.STRING,
      actorUserId: DataTypes.BIGINT,
      impersonatedTenantId: DataTypes.STRING,
      tenantContextSource: DataTypes.STRING,
      isTenantImpersonation: DataTypes.BOOLEAN,
    };

    for (const [name, type] of Object.entries(columns)) {
      if (!table[name]) {
        await queryInterface.addColumn(tableName, name, {
          type,
          allowNull: true,
        });
      }
    }

    await addIndexIfMissing(queryInterface, tableName, 'tenantId', 'audit_logs_tenant_id');
    await addIndexIfMissing(queryInterface, tableName, 'actorUserId', 'audit_logs_actor_user_id');
    await addIndexIfMissing(queryInterface, tableName, 'impersonatedTenantId', 'audit_logs_impersonated_tenant_id');
  }
}
