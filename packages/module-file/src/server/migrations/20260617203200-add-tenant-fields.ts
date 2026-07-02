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

async function hasColumn(queryInterface: any, tableName: string, columnName: string) {
  if (!(await hasTable(queryInterface, tableName))) {
    return false;
  }

  const table = await queryInterface.describeTable(tableName);
  return !!table[columnName];
}

function quoteTable(queryInterface: any, tableName: string) {
  return queryInterface.quoteTable ? queryInterface.quoteTable(tableName) : `"${tableName}"`;
}

function quoteIdentifier(queryInterface: any, columnName: string) {
  return queryInterface.quoteIdentifier ? queryInterface.quoteIdentifier(columnName) : `"${columnName}"`;
}

async function backfillAttachmentTenantIds(db: any, queryInterface: any) {
  const tableName = 'attachments';
  const hasCreatedBy = await hasColumn(queryInterface, tableName, 'createdById');
  if (!hasCreatedBy) {
    return;
  }

  const attachments = quoteTable(queryInterface, tableName);
  const users = quoteTable(queryInterface, 'users');
  const tenantUsers = quoteTable(queryInterface, 'tenantUsers');
  const id = quoteIdentifier(queryInterface, 'id');
  const tenantId = quoteIdentifier(queryInterface, 'tenantId');
  const createdById = quoteIdentifier(queryInterface, 'createdById');
  const defaultTenantId = quoteIdentifier(queryInterface, 'defaultTenantId');
  const userId = quoteIdentifier(queryInterface, 'userId');

  if (await hasColumn(queryInterface, 'users', 'defaultTenantId')) {
    await db.sequelize.query(`
      UPDATE ${attachments}
      SET ${tenantId} = (
        SELECT ${users}.${defaultTenantId}
        FROM ${users}
        WHERE ${users}.${id} = ${attachments}.${createdById}
          AND ${users}.${defaultTenantId} IS NOT NULL
      )
      WHERE ${tenantId} IS NULL
        AND ${createdById} IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM ${users}
          WHERE ${users}.${id} = ${attachments}.${createdById}
            AND ${users}.${defaultTenantId} IS NOT NULL
        )
    `);
  }

  if (await hasColumn(queryInterface, 'tenantUsers', 'tenantId')) {
    await db.sequelize.query(`
      UPDATE ${attachments}
      SET ${tenantId} = (
        SELECT MIN(${tenantUsers}.${tenantId})
        FROM ${tenantUsers}
        WHERE ${tenantUsers}.${userId} = ${attachments}.${createdById}
          AND ${tenantUsers}.${tenantId} IS NOT NULL
        GROUP BY ${tenantUsers}.${userId}
        HAVING COUNT(DISTINCT ${tenantUsers}.${tenantId}) = 1
      )
      WHERE ${tenantId} IS NULL
        AND ${createdById} IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT ${tenantUsers}.${tenantId})
          FROM ${tenantUsers}
          WHERE ${tenantUsers}.${userId} = ${attachments}.${createdById}
            AND ${tenantUsers}.${tenantId} IS NOT NULL
        ) = 1
    `);
  }
}

export default class AddTenantFieldsToAttachmentsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = 'attachments';

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

    await backfillAttachmentTenantIds(this.db, queryInterface);
    await addIndexIfMissing(queryInterface, tableName, 'tenantId', 'attachments_tenant_id');
  }
}
