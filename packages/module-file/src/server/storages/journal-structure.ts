import type { Collection, Database, Transaction } from '@tego/server';

/** Physical structure of internal two-column evidence tables, held stable until transaction end. */
export async function lockAttachmentJournalStructure(
  database: Database,
  model: Collection['model'],
  columns: readonly string[],
  transaction: Transaction,
  error: string,
): Promise<void> {
  const generator = database.sequelize.getQueryInterface().queryGenerator as unknown as {
    quoteTable(table: unknown): string;
  };
  const table = generator.quoteTable(model.getTableName());
  // INSERT-compatible lock prevents a concurrent ALTER TABLE adding columns or blocking FKs.
  await database.sequelize.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`, { transaction });
  const [rows] = await database.sequelize.query(
    `SELECT
      ARRAY(SELECT attname::text FROM pg_attribute
        WHERE attrelid = to_regclass($table) AND attnum > 0 AND NOT attisdropped) AS columns,
      EXISTS(SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass($table) AND contype = 'f') AS "hasReferences",
      EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.conrelid = to_regclass($table) AND c.contype = 'p'
          AND array_length(c.conkey, 1) = 1 AND a.attname = $key) AS "hasPrimary"`,
    { transaction, bind: { table, key: columns[0] } },
  );
  const schema = (rows as { columns: string[]; hasReferences: boolean; hasPrimary: boolean }[])[0];
  if (
    !schema ||
    schema.hasReferences ||
    !schema.hasPrimary ||
    schema.columns.length !== columns.length ||
    columns.some((column) => !schema.columns.includes(column))
  )
    throw new TypeError(error);
}
