import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection } from '@tego/server';

import { getTenantStoragePath } from '../utils';
import type { StagedAttachmentStorage } from './staged-upload';

const storageFields = ['id', 'title', 'name', 'type', 'baseUrl', 'path', 'options', 'rules', 'default', 'paranoid'];

export interface StagedAttachmentStorageSelection {
  /** Raw server configuration. Render environment values and apply tenant paths separately; never return to clients. */
  readonly values: Record<string, unknown>;
  /** Call before file side effects and again before commit, in the sufficiently isolated owned write transaction. */
  assertCurrent(transaction: Transaction): Promise<void>;
}

/** Server rendering and directory namespacing only, not storage-use authorization. Never pass request tenant values. */
export function renderStagedAttachmentStorage(
  selection: StagedAttachmentStorageSelection,
  render: (values: Record<string, unknown>) => unknown,
  tenantId?: string | number,
): StagedAttachmentStorage {
  if (
    typeof render !== 'function' ||
    (tenantId !== undefined &&
      !(
        (typeof tenantId === 'string' && tenantId.length > 0 && tenantId.length <= 255) ||
        (typeof tenantId === 'number' && Number.isSafeInteger(tenantId))
      ))
  )
    throw new TypeError('Attachment storage rendering requires a server renderer and trusted tenant identity');
  const raw = selection.values;
  const identity = { id: raw.id, type: raw.type, name: raw.name };
  const rendered = render(raw);
  if (rendered instanceof Promise) {
    void rendered.catch(() => {});
    throw new TypeError('Attachment storage renderer must be synchronous');
  }
  if (
    !rendered ||
    typeof rendered !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(rendered)) ||
    Object.entries(identity).some(([key, value]) => rendered[key] !== value)
  )
    throw new TypeError('Rendered attachment storage identity changed');
  const captured = structuredClone(rendered) as StagedAttachmentStorage;
  if (
    typeof captured.path !== 'string' ||
    typeof captured.baseUrl !== 'string' ||
    !captured.options ||
    typeof captured.options !== 'object' ||
    Array.isArray(captured.options)
  )
    throw new TypeError('Rendered attachment storage configuration is invalid');
  captured.path = getTenantStoragePath(captured.path, tenantId);
  return captured;
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
