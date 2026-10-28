import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection } from '@tego/server';

import { applyFilePresentation } from '../FileModel';
import type { StagedAttachmentStorage, StagedAttachmentStorageValues } from './staged-upload';

const managedFields = ['filename', 'extname', 'path', 'url', 'mimetype', 'size', 'meta', 'storageId'] as const;

/**
 * Capture before persistence; verify at the end of the owned write transaction.
 * This checks storage metadata only. The caller must authorize ACL/G and supply its actual INSERT receipt key.
 * Do not use this query to authorize access, select storage, or claim an existing record.
 */
export function captureStagedAttachmentRecord(collection: Collection, values: StagedAttachmentStorageValues) {
  const read = captureRecord(collection, values);
  return async (key: string | number, transaction: Transaction): Promise<void> => {
    await read(key, transaction);
  };
}

/**
 * Bounded creation receipt, not a general read permission. Supply the authorized actual INSERT key.
 * Call inside the owned write transaction, then publish only after its successful commit.
 * Storage is trusted server selection; no arbitrary fields, associations or storage options are returned.
 */
export function captureStagedAttachmentResponse(
  collection: Collection,
  values: StagedAttachmentStorageValues,
  storage?: Pick<StagedAttachmentStorage, 'id' | 'type' | 'options'>,
) {
  if (storage && String(storage.id) !== String(values.storageId))
    throw new TypeError('Attachment response storage does not match');
  const presentation = storage
    ? structuredClone({ type: storage.type, options: { thumbnailRule: storage.options?.thumbnailRule } })
    : undefined;
  const publicPath = process.env.APP_PUBLIC_PATH;
  const primary = collection.model.primaryKeyAttribute;
  const fields = [...new Set([primary, 'title', ...managedFields])];
  const read = captureRecord(collection, values, ['title']);
  return async (key: string | number, transaction: Transaction): Promise<Record<string, unknown>> => {
    const record = await read(key, transaction);
    const response = Object.fromEntries(fields.map((field) => [field, structuredClone(record.getDataValue(field))]));
    return presentation ? applyFilePresentation(response, presentation, publicPath) : response;
  };
}

function captureRecord(collection: Collection, values: StagedAttachmentStorageValues, extraFields: string[] = []) {
  const db = collection.db;
  const model = collection.model;
  const name = collection.name;
  const primary = model.primaryKeyAttribute;
  const table = JSON.stringify(model.getTableName());
  const expected = structuredClone(values);
  const attributes = [...new Set([primary, ...managedFields, ...extraFields])];
  const metadata = attributes.map((field) => {
    const attribute = model.rawAttributes[field];
    if (!attribute || (attribute.type as { key?: string }).key === 'VIRTUAL')
      throw new TypeError('Attachment storage requires physical metadata fields');
    return { field, attribute, column: attribute.field, type: String(attribute.type) };
  });
  const current = () => {
    if (
      collection.options.template !== 'file' ||
      collection.db !== db ||
      db.getCollection(name) !== collection ||
      db.modelCollection.get(model) !== collection ||
      collection.model !== model ||
      model.primaryKeyAttributes.length !== 1 ||
      model.primaryKeyAttribute !== primary ||
      JSON.stringify(model.getTableName()) !== table ||
      metadata.some(
        ({ field, attribute, column, type }) =>
          model.rawAttributes[field] !== attribute || attribute.field !== column || String(attribute.type) !== type,
      )
    )
      throw new TypeError('Attachment storage record identity changed');
  };
  current();
  return async (key: string | number, transaction: Transaction) => {
    const state = transaction as Transaction & { sequelize?: typeof db.sequelize; finished?: string };
    if (
      !(transaction instanceof Transaction) ||
      state.sequelize !== db.sequelize ||
      state.finished ||
      !(
        (typeof key === 'string' && key.length > 0 && key.length <= 255) ||
        (typeof key === 'number' && Number.isSafeInteger(key))
      )
    )
      throw new TypeError('Attachment verification requires its active write transaction and record key');
    current();
    const options = {
      transaction,
      attributes,
      hooks: false,
      useMaster: true,
      lock: transaction.LOCK.UPDATE,
    };
    const record = await model.unscoped().findByPk(key, options);
    current();
    // Keep dialect JSON decoding, but never call presentation getters or Model.get().
    if (
      !record ||
      managedFields.some((field) =>
        field === 'storageId'
          ? record.getDataValue(field) == null || String(record.getDataValue(field)) !== String(expected[field])
          : !isDeepStrictEqual(record.getDataValue(field), expected[field]),
      )
    )
      throw new TypeError('Persisted attachment storage metadata changed');
    return record;
  };
}
