import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database, Transaction } from '@tego/server';

import { assertForeignKeyWriteIsolation } from './association-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessConfig } from './types';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

export interface AccessAttachmentCreationStorage {
  /** Server-selected configuration key, never a request value or a normal reference selection. */
  readonly key: string | number;
  /** Trusted storage adapter must lock/recheck its actual selection in this write transaction. */
  assertCurrent(transaction: Transaction): Promise<void>;
}

/** Narrow storage injection for one new file record. This does not grant operation or storage-use authority. */
export function prepareAttachmentCreationStorage(
  db: Database,
  collection: Collection,
  config: AccessConfig,
  selected: AccessAttachmentCreationStorage,
) {
  if (!plain(selected)) invalid('Attachment creation requires a trusted storage selection');
  const key = Object.getOwnPropertyDescriptor(selected, 'key');
  const check = Object.getOwnPropertyDescriptor(selected, 'assertCurrent');
  if (
    !key ||
    !Object.hasOwn(key, 'value') ||
    !check ||
    !Object.hasOwn(check, 'value') ||
    typeof check.value !== 'function'
  )
    invalid('Attachment creation requires an explicit storage key and validation function');
  const value = key.value;
  const assertCurrent = check.value as AccessAttachmentCreationStorage['assertCurrent'];
  const target = db.getCollection('storages');
  const sourceModel = collection.model;
  const targetModel = target?.model;
  const relation = sourceModel.associations.storage as (typeof sourceModel.associations)[string] & {
    foreignKey?: string;
    targetKey?: string;
    scope?: unknown;
  };
  const field = collection.getField('storage');
  const attribute = sourceModel.rawAttributes.storageId;
  const references = cloneDeep(attribute?.references);
  const current = () => {
    if (
      collection.db !== db ||
      collection.options.template !== 'file' ||
      !target ||
      target.db !== db ||
      db.getCollection('storages') !== target ||
      !field ||
      collection.getField('storage') !== field ||
      field.target !== 'storages' ||
      !relation ||
      sourceModel.associations.storage !== relation ||
      relation.source !== sourceModel ||
      relation.target !== targetModel ||
      relation.associationType !== 'BelongsTo' ||
      relation.foreignKey !== 'storageId' ||
      relation.targetKey !== 'id' ||
      sourceModel.primaryKeyAttributes.includes('storageId') ||
      targetModel.primaryKeyAttribute !== 'id' ||
      targetModel.primaryKeyAttributes.length !== 1 ||
      !attribute ||
      sourceModel.rawAttributes.storageId !== attribute ||
      !isDeepStrictEqual(attribute.references, references) ||
      (relation.scope != null && (!plain(relation.scope) || Reflect.ownKeys(relation.scope).length !== 0)) ||
      Object.entries(sourceModel.rawAttributes).some(
        ([name, other]) => name !== 'storageId' && (other.field ?? name) === (attribute.field ?? 'storageId'),
      )
    )
      invalid('Attachment creation storage relationship is unsupported or changed');
    assertForeignKeyWriteIsolation(db, sourceModel, targetModel, relation, 'storageId', 'id');
  };
  current();
  const normalized = normalizeKeys([value], target)[0];
  const metadata = accessMetadataGuard(
    db,
    [{ model: sourceModel, config }],
    [{ model: sourceModel, path: ['storage'] }],
  );
  return {
    value,
    current() {
      current();
      metadata();
    },
    accepts(value: unknown) {
      return value != null && normalizeKeys([value], target)[0] === normalized;
    },
    async verify(transaction: Transaction) {
      current();
      metadata();
      await assertCurrent(transaction);
      current();
      metadata();
    },
  };
}
