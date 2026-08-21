import { DataTypes, Migration, snakeCase } from '@tego/server';

const DUPLICATE_TENANT_NAMES_ERROR = 'Duplicate tenant names found. Rename duplicate tenants before upgrading.';

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
  columnName: string,
  indexName: string,
  transaction: any,
) {
  const indexes = await queryInterface.showIndex(tableName, { transaction });
  const exists = indexes.some((index) => {
    const fields = (index.fields || []).map((field: any) => field.attribute || field.name).filter(Boolean);
    return index.name === indexName || (fields.length === 1 && fields[0] === columnName);
  });

  if (!exists) {
    await queryInterface.addIndex(tableName, [columnName], { name: indexName, transaction });
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.name === 'SequelizeUniqueConstraintError';
}

function getTemporaryNames(reservedNames: Set<string>, count: number) {
  const temporaryNames: string[] = [];
  let candidateNumber = 0;

  while (temporaryNames.length < count) {
    const candidate = `__tenant_name_migration_${candidateNumber}__`;
    candidateNumber += 1;
    if (!reservedNames.has(candidate)) {
      temporaryNames.push(candidate);
    }
  }

  return temporaryNames;
}

function quoteTable(queryInterface: any, tableName: string) {
  return queryInterface.queryGenerator.quoteTable(tableName);
}

function quoteIdentifier(queryInterface: any, columnName: string) {
  return queryInterface.queryGenerator.quoteIdentifier(columnName);
}

export default class UseTenantNameMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.41';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'tenants';
    const tableName = getPhysicalTableName(this.db, collectionName);

    if (!(await hasTable(queryInterface, tableName))) {
      return;
    }

    const table = await queryInterface.describeTable(tableName);
    const idColumn = getPhysicalColumnName(this.db, collectionName, 'id');
    const nameColumn = getPhysicalColumnName(this.db, collectionName, 'name');
    const titleColumn = getPhysicalColumnName(this.db, collectionName, 'title');
    if (!table[titleColumn]) {
      return;
    }

    const quotedTable = quoteTable(queryInterface, tableName);
    const quotedId = quoteIdentifier(queryInterface, idColumn);
    const quotedName = quoteIdentifier(queryInterface, nameColumn);
    const quotedTitle = quoteIdentifier(queryInterface, titleColumn);
    const idAlias = quoteIdentifier(queryInterface, 'id');
    const nameAlias = quoteIdentifier(queryInterface, 'name');
    const titleAlias = quoteIdentifier(queryInterface, 'title');
    const [selectedRows] = await this.db.sequelize.query(
      `SELECT ${quotedId} AS ${idAlias}, ${quotedName} AS ${nameAlias}, ${quotedTitle} AS ${titleAlias} FROM ${quotedTable}`,
    );
    const rows = selectedRows as Array<{ id: string; name: string; title?: string | null }>;
    const migratedRows = rows.map((row) => ({
      id: row.id,
      name: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : row.name,
    }));
    const finalNames = new Set(migratedRows.map((row) => row.name));

    if (finalNames.size !== migratedRows.length) {
      throw new Error(DUPLICATE_TENANT_NAMES_ERROR);
    }

    const reservedNames = new Set([...finalNames, ...rows.map((row) => row.name)]);
    const temporaryNames = getTemporaryNames(reservedNames, migratedRows.length);
    const parentIdColumn = getPhysicalColumnName(this.db, collectionName, 'parentId');
    const pathColumn = getPhysicalColumnName(this.db, collectionName, 'path');
    try {
      await this.db.sequelize.transaction(async (transaction) => {
        for (const [index, row] of migratedRows.entries()) {
          await queryInterface.bulkUpdate(
            tableName,
            { [nameColumn]: temporaryNames[index] },
            { [idColumn]: row.id },
            { transaction },
          );
        }

        for (const row of migratedRows) {
          await queryInterface.bulkUpdate(
            tableName,
            { [nameColumn]: row.name },
            { [idColumn]: row.id },
            { transaction },
          );
        }

        await queryInterface.removeColumn(tableName, titleColumn, { transaction });
        await addIndexIfMissing(
          queryInterface,
          tableName,
          parentIdColumn,
          snakeCase(`${tableName}_parentId`),
          transaction,
        );
        await addIndexIfMissing(queryInterface, tableName, pathColumn, snakeCase(`${tableName}_path`), transaction);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error(DUPLICATE_TENANT_NAMES_ERROR);
      }
      throw error;
    }
  }

  async down() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const collectionName = 'tenants';
    const tableName = getPhysicalTableName(this.db, collectionName);

    if (!(await hasTable(queryInterface, tableName))) {
      return;
    }

    const table = await queryInterface.describeTable(tableName);
    const idColumn = getPhysicalColumnName(this.db, collectionName, 'id');
    const nameColumn = getPhysicalColumnName(this.db, collectionName, 'name');
    const titleColumn = getPhysicalColumnName(this.db, collectionName, 'title');
    if (table[titleColumn]) {
      return;
    }

    await this.db.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        tableName,
        titleColumn,
        {
          type: DataTypes.STRING,
          allowNull: true,
        },
        { transaction },
      );

      const quotedTable = quoteTable(queryInterface, tableName);
      const quotedId = quoteIdentifier(queryInterface, idColumn);
      const quotedName = quoteIdentifier(queryInterface, nameColumn);
      const idAlias = quoteIdentifier(queryInterface, 'id');
      const nameAlias = quoteIdentifier(queryInterface, 'name');
      const [selectedRows] = await this.db.sequelize.query(
        `SELECT ${quotedId} AS ${idAlias}, ${quotedName} AS ${nameAlias} FROM ${quotedTable}`,
        { transaction },
      );
      const rows = selectedRows as Array<{ id: string; name: string }>;

      for (const row of rows) {
        await queryInterface.bulkUpdate(
          tableName,
          { [titleColumn]: row.name },
          { [idColumn]: row.id },
          { transaction },
        );
      }
    });
  }
}
