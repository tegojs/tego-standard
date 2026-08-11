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

async function removeIndexIfExists(queryInterface: any, tableName: string, indexName: string) {
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some((index) => index.name === indexName)) {
    await queryInterface.removeIndex(tableName, indexName);
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
  const attachmentsTableName = getPhysicalTableName(db, 'attachments');
  const usersTableName = getPhysicalTableName(db, 'users');
  const tenantUsersTableName = getPhysicalTableName(db, 'tenantUsers');
  const tenantIdColumn = getPhysicalColumnName(db, 'attachments', 'tenantId');
  const createdByIdColumn = getPhysicalColumnName(db, 'attachments', 'createdById');
  const userIdColumn = getPhysicalColumnName(db, 'tenantUsers', 'userId');
  const tenantUserTenantIdColumn = getPhysicalColumnName(db, 'tenantUsers', 'tenantId');
  const userIdPrimaryColumn = getPhysicalColumnName(db, 'users', 'id');
  const defaultTenantIdColumn = getPhysicalColumnName(db, 'users', 'defaultTenantId');
  const hasCreatedBy = await hasColumn(queryInterface, attachmentsTableName, createdByIdColumn);
  if (!hasCreatedBy) {
    return;
  }

  const attachments = quoteTable(queryInterface, attachmentsTableName);
  const users = quoteTable(queryInterface, usersTableName);
  const tenantUsers = quoteTable(queryInterface, tenantUsersTableName);
  const id = quoteIdentifier(queryInterface, userIdPrimaryColumn);
  const tenantId = quoteIdentifier(queryInterface, tenantIdColumn);
  const tenantUserTenantId = quoteIdentifier(queryInterface, tenantUserTenantIdColumn);
  const createdById = quoteIdentifier(queryInterface, createdByIdColumn);
  const defaultTenantId = quoteIdentifier(queryInterface, defaultTenantIdColumn);
  const userId = quoteIdentifier(queryInterface, userIdColumn);

  if (await hasColumn(queryInterface, usersTableName, defaultTenantIdColumn)) {
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

  if (await hasColumn(queryInterface, tenantUsersTableName, tenantUserTenantIdColumn)) {
    await db.sequelize.query(`
      UPDATE ${attachments}
      SET ${tenantId} = (
        SELECT MIN(${tenantUsers}.${tenantUserTenantId})
        FROM ${tenantUsers}
        WHERE ${tenantUsers}.${userId} = ${attachments}.${createdById}
          AND ${tenantUsers}.${tenantUserTenantId} IS NOT NULL
        GROUP BY ${tenantUsers}.${userId}
        HAVING COUNT(DISTINCT ${tenantUsers}.${tenantUserTenantId}) = 1
      )
      WHERE ${tenantId} IS NULL
        AND ${createdById} IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT ${tenantUsers}.${tenantUserTenantId})
          FROM ${tenantUsers}
          WHERE ${tenantUsers}.${userId} = ${attachments}.${createdById}
            AND ${tenantUsers}.${tenantUserTenantId} IS NOT NULL
        ) = 1
    `);
  }
}

export default class AddTenantFieldsToAttachmentsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.23';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'attachments';
    const tableName = getPhysicalTableName(this.db, collectionName);
    const tenantId = getPhysicalColumnName(this.db, collectionName, 'tenantId');

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

    await backfillAttachmentTenantIds(this.db, queryInterface);
    await addIndexIfMissing(queryInterface, tableName, tenantId, 'attachments_tenant_id');
  }

  async down() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'attachments';
    const tableName = getPhysicalTableName(this.db, collectionName);
    const tenantId = getPhysicalColumnName(this.db, collectionName, 'tenantId');

    if (!(await hasTable(queryInterface, tableName))) {
      this.app?.logger?.info?.(`[migration skipped] table ${tableName} does not exist`);
      return;
    }

    await removeIndexIfExists(queryInterface, tableName, 'attachments_tenant_id');

    if (await hasColumn(queryInterface, tableName, tenantId)) {
      await queryInterface.removeColumn(tableName, tenantId);
    }
  }
}
