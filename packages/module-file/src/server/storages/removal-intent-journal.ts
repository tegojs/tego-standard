import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection, type Database } from '@tego/server';

import type { AuthorizedAttachmentRemovalPreparation } from './authorized-removal-storage';
import { lockAttachmentJournalStructure } from './journal-structure';
import { getLocalStorageRoot } from './local-root';
import { AttachmentRemovalNativeCapture } from './native-removal-capture';

interface SourceProvenance {
  transactionId: string;
  oid: string;
  schema: string;
  tableName: string;
  tenantId: string | null;
}

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
  private readonly preparations = new WeakMap<
    Readonly<{ id: string }>,
    {
      collection: Collection;
      transaction: Transaction;
      payload: ReturnType<AttachmentRemovalIntentJournal['capture']>;
    }
  >();

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

  private assertTransaction(preparation: Pick<AuthorizedAttachmentRemovalPreparation, 'collection' | 'transaction'>) {
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

  private async sourceProvenance(preparation: AuthorizedAttachmentRemovalPreparation): Promise<SourceProvenance> {
    this.assertTransaction(preparation);
    const model = preparation.collection.model;
    const primaryField = model.rawAttributes[model.primaryKeyAttribute]?.field;
    const owner = model.rawAttributes.tenantId;
    if (!primaryField || (owner && (!owner.field || (owner.type as { key?: string }).key === 'VIRTUAL')))
      throw new TypeError('Removal intent requires physical source identity and ownership fields');
    const primary = `"${primaryField.replaceAll('"', '""')}"`;
    const [rows] = await this.database.sequelize.query(
      `SELECT pg_catalog.txid_current()::text AS "transactionId", original.tableoid::text AS oid,
        n.nspname::text AS schema, c.relname::text AS "tableName",
        pg_catalog.to_jsonb(original)->>$owner AS "tenantId"
      FROM ${this.quoteTable(model)} AS original
      JOIN pg_catalog.pg_class c ON c.oid=original.tableoid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE original.${primary}=$key FOR UPDATE OF original`,
      {
        transaction: preparation.transaction,
        bind: { key: preparation.record.key, owner: owner?.field ?? null },
      },
    );
    this.assertTransaction(preparation);
    const result = (rows as SourceProvenance[])[0];
    if (
      (rows as SourceProvenance[]).length !== 1 ||
      !result ||
      !/^\d+$/.test(result.transactionId) ||
      !/^\d+$/.test(result.oid) ||
      !result.schema ||
      !result.tableName ||
      (result.tenantId !== null && typeof result.tenantId !== 'string')
    )
      throw new TypeError('Removal intent source transaction and actual record are unavailable');
    return result;
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

  private capture(preparation: AuthorizedAttachmentRemovalPreparation, provenance: SourceProvenance) {
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
      // Older prepared entries lack original transaction/ownership evidence and cannot be upgraded by guessing.
      schemaVersion: 2,
      kind: 'attachment-removal-intent',
      state: 'prepared',
      transactionId: provenance.transactionId,
      source: {
        collectionName: preparation.collection.name,
        table: this.quoteTable(preparation.collection.model),
        primaryKey: preparation.collection.model.primaryKeyAttribute,
        primaryField:
          preparation.collection.model.rawAttributes[preparation.collection.model.primaryKeyAttribute].field,
        ownerField: preparation.collection.model.rawAttributes.tenantId?.field ?? null,
        oid: provenance.oid,
        schema: provenance.schema,
        tableName: provenance.tableName,
      },
      record: { ...preparation.record, tenantId: provenance.tenantId },
      storage: { root, retainContent: preparation.retainContent },
    });
  }

  /** Caller must await inside the preparation callback and roll back its transaction on any error. */
  async persist(preparation: AuthorizedAttachmentRemovalPreparation): Promise<Readonly<{ id: string }>> {
    this.assertTransaction(preparation);
    await preparation.assertCurrent();
    const { transaction } = preparation;
    await this.lockStructure(transaction);
    await preparation.assertCurrent();
    const provenance = await this.sourceProvenance(preparation);
    await preparation.assertCurrent();
    const payload = this.capture(preparation, provenance);
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
    const currentProvenance = await this.sourceProvenance(preparation);
    await preparation.assertCurrent();
    if (
      !isDeepStrictEqual(this.capture(preparation, currentProvenance), payload) ||
      !row ||
      row.getDataValue('id') !== id ||
      !isDeepStrictEqual(row.getDataValue('payload'), payload)
    )
      throw new TypeError('Removal intent was not stored unchanged');
    const handle = Object.freeze({ id });
    this.preparations.set(handle, {
      collection: preparation.collection,
      transaction,
      payload: structuredClone(payload),
    });
    return handle;
  }

  private async verifiedPreparation(handle: Readonly<{ id: string }>, transaction: Transaction) {
    const original = this.preparations.get(handle);
    if (!original) throw new TypeError('Original removal intent handle is unavailable');
    if (original.transaction !== transaction) throw new TypeError('Original removal intent transaction is unavailable');
    this.assertTransaction(original);
    await this.lockStructure(transaction);
    const options = {
      attributes: ['id', 'payload'],
      hooks: false,
      useMaster: true,
      transaction,
      lock: transaction.LOCK.UPDATE,
    };
    const row = await this.model.unscoped().findByPk(handle.id, options);
    this.assertTransaction(original);
    if (
      !row ||
      row.getDataValue('id') !== handle.id ||
      !isDeepStrictEqual(row.getDataValue('payload'), original.payload)
    )
      throw new TypeError('Removal intent no longer matches its original preparation');
    return original;
  }

  private expectedEvent(payload: ReturnType<AttachmentRemovalIntentJournal['capture']>, version: 1 | 2) {
    return {
      schemaVersion: version,
      kind: 'attachment-native-delete',
      state: 'deleted-in-transaction',
      transactionId: payload.transactionId,
      source: {
        oid: payload.source.oid,
        schema: payload.source.schema,
        table: payload.source.tableName,
        primaryField: payload.source.primaryField,
      },
      record: {
        key: String(payload.record.key),
        path: payload.record.path,
        filename: payload.record.filename,
        storageId: String(payload.record.storageId),
        size: String(payload.record.size),
        tenantId: payload.record.tenantId,
      },
    };
  }

  /**
   * Original-transaction consistency check only. No DELETE, state promotion, commit or file I/O.
   * This does not reauthorize G/role facts after preparation, exclude references or prove commit.
   * The caller must still roll back on any failure and provide a separate deletion execution contract.
   */
  async assertNativeEventMatches(
    handle: Readonly<{ id: string }>,
    native: AttachmentRemovalNativeCapture,
    transaction: Transaction,
  ): Promise<void> {
    const original = await this.verifiedPreparation(handle, transaction);
    if (!(native instanceof AttachmentRemovalNativeCapture))
      throw new TypeError('Native removal capture is unavailable');
    const event = await native.readEvent(original.collection, transaction, handle.id);
    this.assertTransaction(original);
    const expected = this.expectedEvent(original.payload, 1);
    if (!isDeepStrictEqual(event, expected))
      throw new TypeError('Native attachment event does not match its prepared intent');
  }

  /**
   * Strict v2 event/intent observation in the original active transaction. The predicate must come
   * from a trusted server compiler; this is not a final action decision or a deletion capability.
   * A false result or any error must cause the independent deletion executor to roll back.
   */
  async testNativeRowPredicate(
    handle: Readonly<{ id: string }>,
    native: AttachmentRemovalNativeCapture,
    transaction: Transaction,
    predicate: { readonly sql: string; readonly rootAlias: string },
  ): Promise<boolean> {
    // Capture caller input before awaits; SQL text is an observation, never a bearer permission.
    const captured = { sql: predicate?.sql, rootAlias: predicate?.rootAlias };
    const original = await this.verifiedPreparation(handle, transaction);
    if (!(native instanceof AttachmentRemovalNativeCapture))
      throw new TypeError('Native removal capture is unavailable');
    const matches = await native.testFullRowPredicate(
      original.collection,
      transaction,
      handle.id,
      this.expectedEvent(original.payload, 2),
      captured,
    );
    await this.verifiedPreparation(handle, transaction);
    return matches;
  }
}
