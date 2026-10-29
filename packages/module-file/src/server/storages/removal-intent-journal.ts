import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection, type Database } from '@tego/server';

import type { AuthorizedAttachmentRemovalPreparation } from './authorized-removal-storage';
import { lockAttachmentJournalStructure } from './journal-structure';
import { getLocalStorageRoot } from './local-root';

/**
 * Explicit internal PostgreSQL collection: independent string id PK and JSON payload only.
 * This records preparation in the caller transaction, never a deletion result or cleanup permit.
 * No table, business-row deletion, file I/O, route or worker is installed.
 */
export class AttachmentRemovalIntentJournal {
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
        throw new TypeError('Removal intent requires physical id and payload fields');
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
      throw new TypeError('Removal intent collection identity is unavailable or changed');
  }

  private assertTransaction(preparation: AuthorizedAttachmentRemovalPreparation) {
    this.assertCurrent();
    const transaction = preparation.transaction as Transaction & {
      sequelize?: Database['sequelize'];
      finished?: string;
      parent?: Transaction;
      options?: { readOnly?: boolean };
    };
    if (
      !(transaction instanceof Transaction) ||
      transaction.sequelize !== this.database.sequelize ||
      transaction.finished ||
      transaction.parent ||
      transaction.options?.readOnly ||
      preparation.collection === this.collection ||
      preparation.collection.db !== this.database
    )
      throw new TypeError('Removal intent must use the source active top-level write transaction');
  }

  private quoteTable(model: Collection['model']) {
    const generator = this.database.sequelize.getQueryInterface().queryGenerator as unknown as {
      quoteTable(table: unknown): string;
    };
    return generator.quoteTable(model.getTableName());
  }

  private async lockStructure(transaction: Transaction) {
    await lockAttachmentJournalStructure(
      this.database,
      this.model,
      this.attributes.map(({ column }) => column),
      transaction,
      'Removal intent table requires its own primary key and no references or extra columns',
    );
    this.assertCurrent();
  }

  private capture(preparation: AuthorizedAttachmentRemovalPreparation) {
    this.assertTransaction(preparation);
    const storage = preparation.storage;
    if (storage.type !== 'local' || storage.id !== preparation.record.storageId)
      throw new TypeError('Removal intent supports only the original local storage');
    const options = storage.options as { documentRoot?: unknown } | undefined;
    const documentRoot = options?.documentRoot;
    if (documentRoot !== undefined && typeof documentRoot !== 'string')
      throw new TypeError('Removal intent requires a valid original local storage root');
    const root = getLocalStorageRoot({ options: typeof documentRoot === 'string' ? { documentRoot } : {} });
    return structuredClone({
      schemaVersion: 1,
      kind: 'attachment-removal-intent',
      state: 'prepared',
      source: {
        collectionName: preparation.collection.name,
        table: this.quoteTable(preparation.collection.model),
        primaryKey: preparation.collection.model.primaryKeyAttribute,
      },
      record: preparation.record,
      storage: { root, retainContent: preparation.retainContent },
    });
  }

  /** Caller must await inside the preparation callback and roll back its transaction on any error. */
  async persist(preparation: AuthorizedAttachmentRemovalPreparation): Promise<Readonly<{ id: string }>> {
    this.assertTransaction(preparation);
    await preparation.assertCurrent();
    const payload = this.capture(preparation);
    const { transaction } = preparation;
    await this.lockStructure(transaction);
    await preparation.assertCurrent();
    if (!isDeepStrictEqual(this.capture(preparation), payload))
      throw new TypeError('Removal intent source or original storage changed');
    const id = randomUUID();
    await this.model.unscoped().create({ id, payload }, { hooks: false, transaction });
    // RETURNING can predate an AFTER INSERT trigger. Read the actually stored payload as well.
    const options = {
      attributes: ['id', 'payload'],
      hooks: false,
      useMaster: true,
      transaction,
      lock: transaction.LOCK.UPDATE,
    };
    const row = await this.model.unscoped().findByPk(id, options);
    await preparation.assertCurrent();
    if (
      !isDeepStrictEqual(this.capture(preparation), payload) ||
      !row ||
      row.getDataValue('id') !== id ||
      !isDeepStrictEqual(row.getDataValue('payload'), payload)
    )
      throw new TypeError('Removal intent was not stored unchanged');
    return Object.freeze({ id });
  }
}
