import { Transaction, type Collection, type Database } from '@tego/server';

import { captureLocalStagedAttachment, verifyLocalStagedAttachment } from './local-recovery';

type LocalLocation = Parameters<typeof verifyLocalStagedAttachment>[0];

/**
 * Internal-only, explicitly registered PostgreSQL receipt collection: string id PK and JSON payload.
 * It must be independent of operation rows, with no foreign keys. No table, route or worker is installed.
 * Receipt persistence is not operation cancellation, authorization or an exclusive cleanup lease.
 */
export class StagedAttachmentReceiptJournal {
  readonly database: Database;
  private readonly model: Collection['model'];
  private readonly table: string;
  private readonly attributes: { key: string; attribute: object; column: string; type: string }[];

  constructor(private readonly collection: Collection) {
    this.database = collection.db;
    this.model = collection.model;
    this.table = JSON.stringify(this.model.getTableName());
    this.attributes = ['id', 'payload'].map((key) => {
      const attribute = this.model.rawAttributes[key];
      const type = (attribute?.type as { key?: string })?.key;
      if (!attribute || !(key === 'payload' ? ['JSON', 'JSONB'] : ['STRING', 'TEXT']).includes(type))
        throw new TypeError('Attachment receipts require physical id and payload fields');
      return { key, attribute, column: attribute.field, type: String(attribute.type) };
    });
    this.assertCurrent();
  }

  private assertCurrent() {
    const { collection, database, model } = this;
    if (
      database.sequelize.getDialect() !== 'postgres' ||
      collection.db !== database ||
      database.getCollection(collection.name) !== collection ||
      collection.model !== model ||
      database.modelCollection.get(model) !== collection ||
      JSON.stringify(model.getTableName()) !== this.table ||
      model.primaryKeyAttributes.length !== 1 ||
      model.primaryKeyAttribute !== 'id' ||
      Object.keys(model.rawAttributes).length !== 2 ||
      this.attributes.some(
        ({ key, attribute, column, type }) =>
          model.rawAttributes[key] !== attribute ||
          model.rawAttributes[key].field !== column ||
          String(model.rawAttributes[key].type) !== type ||
          model.rawAttributes[key].get ||
          model.rawAttributes[key].set ||
          model.rawAttributes[key].references,
      )
    )
      throw new TypeError('Attachment receipt collection identity is unavailable or changed');
  }

  private assertId(id: string) {
    if (typeof id !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(id))
      throw new TypeError('Attachment receipt requires an operation identifier');
  }

  private async lockStructure(transaction: Transaction) {
    const generator = this.database.sequelize.getQueryInterface().queryGenerator as unknown as {
      quoteTable(table: unknown): string;
    };
    const table = generator.quoteTable(this.model.getTableName());
    // Hold the same lock as INSERT, preventing ALTER TABLE from adding a blocking FK between
    // catalog inspection and persistence. This never locks an operation row or a referenced table.
    await this.database.sequelize.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`, { transaction });
    const [rows] = await this.database.sequelize.query(
      `
      SELECT
        ARRAY(SELECT attname::text FROM pg_attribute
          WHERE attrelid = to_regclass($table) AND attnum > 0 AND NOT attisdropped) AS columns,
        EXISTS(SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass($table) AND contype = 'f') AS "hasReferences",
        EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.conrelid = to_regclass($table) AND c.contype = 'p'
            AND array_length(c.conkey, 1) = 1 AND a.attname = $key) AS "hasPrimary"
    `,
      { transaction, bind: { table, key: this.attributes[0].column } },
    );
    const schema = (rows as { columns: string[]; hasReferences: boolean; hasPrimary: boolean }[])[0];
    this.assertCurrent();
    if (
      !schema ||
      schema.hasReferences ||
      !schema.hasPrimary ||
      schema.columns.length !== 2 ||
      this.attributes.some(({ column }) => !schema.columns.includes(column))
    )
      throw new TypeError(
        'Attachment receipt table must have its own primary key and no foreign keys or extra columns',
      );
  }

  /** Called from the trusted pre-copy callback; never join the original business transaction. */
  async persist(id: string, expected: LocalLocation, receipt: unknown): Promise<void> {
    this.assertCurrent();
    this.assertId(id);
    const captured = captureLocalStagedAttachment(expected, receipt);
    const location = { root: captured.location.root, values: captured.location };
    const object = await verifyLocalStagedAttachment(location, captured.receipt);
    this.assertCurrent();
    if (object.state !== 'present' || object.size !== 0)
      throw new TypeError('Attachment receipt must be persisted before copying content');
    // Independent commit, never the caller's transaction. INSERT only: a duplicate operation
    // cannot overwrite earlier ownership evidence. The table lock protects physical FK/PK checks.
    const options = { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED, transaction: null };
    await this.database.sequelize.transaction(options, async (transaction) => {
      await this.lockStructure(transaction);
      await this.model.unscoped().create({ id, payload: captured.receipt }, { hooks: false, transaction });
      this.assertCurrent();
    });
    this.assertCurrent();
  }

  /** Fresh primary read and actual object validation. Missing evidence never authorizes cleanup. */
  async inspect(id: string, expected: LocalLocation) {
    this.assertCurrent();
    this.assertId(id);
    const location = {
      root: expected.root,
      values: {
        path: expected.values.path,
        filename: expected.values.filename,
        storageId: expected.values.storageId,
        size: expected.values.size,
      },
    };
    const options = { attributes: ['id', 'payload'], hooks: false, useMaster: true, transaction: null };
    const row = await this.model.unscoped().findByPk(id, options);
    this.assertCurrent();
    if (!row || row.getDataValue('id') !== id) throw new TypeError('Attachment identity receipt is unavailable');
    const captured = captureLocalStagedAttachment(location, row.getDataValue('payload'));
    const object = await verifyLocalStagedAttachment(location, captured.receipt);
    this.assertCurrent();
    return Object.freeze({ receipt: captured.receipt, object });
  }
}
