import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection } from '@tego/server';

const storageFields = ['id', 'title', 'name', 'type', 'baseUrl', 'path', 'options', 'rules', 'default', 'paranoid'];

export interface StagedAttachmentStorageSelection {
  /** Raw server configuration. Render environment values and apply tenant paths separately; never return to clients. */
  readonly values: Record<string, unknown>;
  /** Call before file side effects and again before commit, in the sufficiently isolated owned write transaction. */
  assertCurrent(transaction: Transaction): Promise<void>;
}

/** Internal configuration selection, not operation, field or target access authorization. No runtime registration. */
export async function resolveStagedAttachmentStorage(
  collection: Collection,
): Promise<StagedAttachmentStorageSelection> {
  const db = collection.db;
  const model = collection.model;
  const name = collection.name;
  const configured = collection.options.storage;
  if (configured !== undefined && (typeof configured !== 'string' || !configured.length || configured.length > 255))
    throw new TypeError('Attachment storage configuration is invalid');
  const storage = db.getCollection('storages');
  const target = storage?.model;
  const field = collection.getField('storage');
  const relation = model.associations.storage as (typeof model.associations)[string] & {
    foreignKey?: string;
    targetKey?: string;
    scope?: unknown;
  };
  const tables = JSON.stringify([model.getTableName(), target?.getTableName()]);
  const metadata = storageFields.map((key) => {
    const attribute = target?.rawAttributes[key];
    if (!attribute || (attribute.type as { key?: string }).key === 'VIRTUAL')
      throw new TypeError('Attachment storage metadata is unavailable');
    return { key, attribute, column: attribute.field, type: String(attribute.type) };
  });
  const foreignKey = model.rawAttributes.storageId;
  const foreignColumn = foreignKey?.field;
  const foreignType = String(foreignKey?.type);
  const current = () => {
    if (
      collection.db !== db ||
      collection.name !== name ||
      db.getCollection(name) !== collection ||
      collection.model !== model ||
      db.modelCollection.get(model) !== collection ||
      collection.options.template !== 'file' ||
      collection.options.storage !== configured ||
      !storage ||
      storage.db !== db ||
      db.getCollection('storages') !== storage ||
      storage.model !== target ||
      db.modelCollection.get(target) !== storage ||
      !field ||
      collection.getField('storage') !== field ||
      field.target !== storage.name ||
      !relation ||
      model.associations.storage !== relation ||
      relation.source !== model ||
      relation.target !== target ||
      relation.associationType !== 'BelongsTo' ||
      (relation.scope != null &&
        (typeof relation.scope !== 'object' ||
          Object.getPrototypeOf(relation.scope) !== Object.prototype ||
          Reflect.ownKeys(relation.scope).length !== 0)) ||
      relation.foreignKey !== 'storageId' ||
      relation.targetKey !== 'id' ||
      target.primaryKeyAttributes.length !== 1 ||
      target.primaryKeyAttribute !== 'id' ||
      !foreignKey ||
      model.rawAttributes.storageId !== foreignKey ||
      foreignKey.field !== foreignColumn ||
      String(foreignKey.type) !== foreignType ||
      JSON.stringify([model.getTableName(), target.getTableName()]) !== tables ||
      metadata.some(
        ({ key, attribute, column, type }) =>
          target.rawAttributes[key] !== attribute || attribute.field !== column || String(attribute.type) !== type,
      )
    )
      throw new TypeError('Attachment storage selection identity changed');
  };
  current();
  const read = async (transaction?: Transaction) => {
    const options = {
      where: configured === undefined ? { default: true } : { name: configured },
      attributes: storageFields,
      limit: 2,
      hooks: false,
      useMaster: true,
      ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
    };
    const records = await target.unscoped().findAll(options);
    current();
    return records.map((record) => Object.fromEntries(storageFields.map((key) => [key, record.getDataValue(key)])));
  };
  const records = await read();
  if (records.length !== 1) throw new TypeError('Attachment requires a unique configured storage');
  const captured = structuredClone(records[0]);
  return Object.freeze({
    get values() {
      return structuredClone(captured);
    },
    async assertCurrent(transaction: Transaction) {
      const state = transaction as Transaction & {
        sequelize?: typeof db.sequelize;
        finished?: string;
        parent?: Transaction;
      };
      if (!(transaction instanceof Transaction) || state.sequelize !== db.sequelize || state.finished || state.parent)
        throw new TypeError('Attachment requires an active storage selection transaction');
      current();
      const latest = await read(transaction);
      if (state.finished) throw new TypeError('Attachment requires an active storage selection transaction');
      if (latest.length !== 1 || !isDeepStrictEqual(latest[0], captured))
        throw new TypeError('Selected attachment storage changed');
    },
  });
}
