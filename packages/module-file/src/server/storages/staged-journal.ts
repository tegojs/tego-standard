import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Op, Transaction, type Collection, type Database } from '@tego/server';

import { getLocalStorageRoot } from './local-root';
import type { StagedAttachmentStorage, StagedAttachmentStorageValues } from './staged-upload';

interface AttachmentJournalPayload {
  root: string;
  values: StagedAttachmentStorageValues;
}

export interface StagedAttachmentRecoveryClaim {
  readonly id: string;
  readonly state: 'committed' | 'cancelled';
  /** Location evidence only, never deletion authority or an exclusive cleanup lease. */
  readonly payload: AttachmentJournalPayload;
}

/**
 * Internal PostgreSQL commit markers. The caller explicitly registers an internal-only collection
 * with string id PK, string state and JSON payload. No tables, routes, workers or cleanup are registered.
 */
export class StagedAttachmentJournal {
  readonly database: Database;
  private readonly model: Collection['model'];
  private readonly table: string;
  private readonly attributes: { key: string; attribute: object; column: string; type: string }[];

  constructor(private readonly collection: Collection) {
    this.database = collection.db;
    this.model = collection.model;
    this.table = JSON.stringify(this.model.getTableName());
    this.attributes = ['id', 'state', 'payload'].map((key) => {
      const attribute = this.model.rawAttributes[key];
      const type = (attribute?.type as { key?: string })?.key;
      if (
        !attribute ||
        !(key === 'payload' ? ['JSON', 'JSONB'] : ['STRING', 'TEXT']).includes(type) ||
        attribute.get ||
        attribute.set
      )
        throw new TypeError('Attachment journal requires physical id, state and payload fields');
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
      this.attributes.some(
        ({ key, attribute, column, type }) =>
          model.rawAttributes[key] !== attribute ||
          model.rawAttributes[key].field !== column ||
          String(model.rawAttributes[key].type) !== type ||
          model.rawAttributes[key].get ||
          model.rawAttributes[key].set,
      )
    )
      throw new TypeError('Attachment journal identity is unavailable or changed');
  }

  private assertTransaction(transaction: Transaction) {
    const state = transaction as Transaction & {
      sequelize?: Database['sequelize'];
      finished?: string;
      parent?: Transaction;
    };
    this.assertCurrent();
    if (
      !(transaction instanceof Transaction) ||
      state.sequelize !== this.database.sequelize ||
      state.finished ||
      state.parent
    )
      throw new TypeError('Attachment journal requires an active owned transaction');
  }

  private async read(id: string, transaction: Transaction) {
    this.assertTransaction(transaction);
    const options = {
      attributes: ['id', 'state', 'payload'],
      hooks: false,
      useMaster: true,
      transaction,
      lock: transaction.LOCK.UPDATE,
    };
    const row = await this.model.unscoped().findByPk(id, options);
    this.assertTransaction(transaction);
    if (
      !row ||
      row.getDataValue('id') !== id ||
      !['pending', 'committed', 'cancelled'].includes(row.getDataValue('state'))
    )
      throw new TypeError('Attachment journal operation is missing or invalid');
    const payload = row.getDataValue('payload');
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.root !== 'string' ||
      !payload.values ||
      typeof payload.values !== 'object'
    )
      throw new TypeError('Attachment journal payload is invalid');
    return row;
  }

  private async setState(
    row: Awaited<ReturnType<StagedAttachmentJournal['read']>>,
    state: 'committed' | 'cancelled',
    transaction: Transaction,
  ) {
    this.assertTransaction(transaction);
    row.setDataValue('state', state);
    await row.save({ fields: ['state'], hooks: false, validate: false, returning: true, transaction });
    this.assertTransaction(transaction);
    if (row.getDataValue('state') !== state) throw new TypeError('Attachment journal state was not persisted');
  }

  /** Autocommit must finish before a file side effect. Only trusted, local storage plans are accepted. */
  async prepare(storage: StagedAttachmentStorage, values: StagedAttachmentStorageValues) {
    this.assertCurrent();
    if (storage.type !== 'local' || storage.id !== values.storageId)
      throw new TypeError('Attachment journal requires the selected local storage plan');
    const payload: AttachmentJournalPayload = structuredClone({ root: getLocalStorageRoot(storage), values });
    const id = randomUUID();
    await this.model.unscoped().create({ id, state: 'pending', payload }, { hooks: false, transaction: null });
    this.assertCurrent();
    let locked: Transaction | undefined;
    let started = false;
    let completed = false;
    return Object.freeze({
      id,
      lock: async (transaction: Transaction) => {
        if (started) throw new TypeError('Attachment journal writer has already started');
        started = true;
        const row = await this.read(id, transaction);
        if (row.getDataValue('state') !== 'pending' || !isDeepStrictEqual(row.getDataValue('payload'), payload))
          throw new TypeError('Attachment journal operation was cancelled or changed');
        // This is the transaction outcome, not an upload-success flag. Mark before invoking the
        // executor so even an invalid early COMMIT cannot be mistaken for a rolled-back upload.
        await this.setState(row, 'committed', transaction);
        locked = transaction;
      },
      complete: async (transaction: Transaction) => {
        if (locked !== transaction || completed) throw new TypeError('Attachment journal writer is not active');
        completed = true;
        const row = await this.read(id, transaction);
        if (row.getDataValue('state') !== 'committed' || !isDeepStrictEqual(row.getDataValue('payload'), payload))
          throw new TypeError('Attachment journal operation was cancelled or changed');
      },
    });
  }

  /** Waits for the original writer and fences pending work. Cancellation is idempotent, not a cleanup lease. */
  async claimRecovery(id: string): Promise<StagedAttachmentRecoveryClaim> {
    this.assertCurrent();
    if (typeof id !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(id))
      throw new TypeError('Attachment recovery requires an operation identifier');
    return this.database.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        const row = await this.read(id, transaction);
        if (row.getDataValue('state') === 'pending') await this.setState(row, 'cancelled', transaction);
        return Object.freeze({
          id,
          state: row.getDataValue('state'),
          payload: structuredClone(row.getDataValue('payload')),
        });
      },
    );
  }

  /** Persist cancellation first, then serialize an awaited trusted recovery under its operation lock.
   * A failed callback never rolls the cancellation fence back to pending. It receives no transaction.
   */
  async withCancelledRecovery<T>(id: string, execute: (payload: AttachmentJournalPayload) => Promise<T>) {
    if (typeof execute !== 'function') throw new TypeError('Attachment recovery requires an awaited server executor');
    const claim = await this.claimRecovery(id);
    if (claim.state === 'committed') return Object.freeze({ state: 'committed' as const });
    const expected = structuredClone(claim.payload);
    return this.database.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        const assertCancelled = async () => {
          const row = await this.read(id, transaction);
          if (row.getDataValue('state') !== 'cancelled' || !isDeepStrictEqual(row.getDataValue('payload'), expected))
            throw new TypeError('Cancelled attachment recovery operation changed');
        };
        await assertCancelled();
        const result = await execute(structuredClone(expected));
        await assertCancelled();
        return Object.freeze({ state: 'cancelled' as const, result });
      },
    );
  }

  /** One discovery page, never a cleanup lease or a claim that all work is complete.
   * Pending operations are deliberately excluded. Skipped locks require a later fresh sweep.
   */
  async listCancelled(options: { after?: string; limit?: number } = {}): Promise<readonly string[]> {
    this.assertCurrent();
    if (
      !options ||
      typeof options !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !['after', 'limit'].includes(key))
    )
      throw new TypeError('Attachment recovery scan options are invalid');
    const fields = Object.getOwnPropertyDescriptors(options);
    if (Object.values(fields).some((field) => !field.enumerable || !Object.hasOwn(field, 'value')))
      throw new TypeError('Attachment recovery scan options must be plain values');
    const after = fields.after?.value;
    const limit = fields.limit?.value === undefined ? 20 : fields.limit.value;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after !== undefined && (typeof after !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(after)))
    )
      throw new TypeError('Attachment recovery requires a bounded page and valid operation cursor');
    const ids = await this.database.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        this.assertTransaction(transaction);
        const query = {
          attributes: ['id'],
          hooks: false,
          useMaster: true,
          where: { state: 'cancelled', ...(after ? { id: { [Op.gt]: after } } : {}) },
          order: [['id', 'ASC'] as [string, 'ASC']],
          limit,
          transaction,
          lock: transaction.LOCK.UPDATE,
          skipLocked: true,
        };
        const rows = await this.model.unscoped().findAll(query);
        this.assertTransaction(transaction);
        return Object.freeze(
          rows.map((row) => {
            const id = row.getDataValue('id');
            if (typeof id !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(id))
              throw new TypeError('Cancelled attachment operation has an invalid identifier');
            return id;
          }),
        );
      },
    );
    this.assertCurrent();
    return ids;
  }
}
