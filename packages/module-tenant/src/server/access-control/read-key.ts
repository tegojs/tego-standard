import type { Collection } from '@tego/server';

import { invalid, normalizeKeys } from './write-support';

/** Capture a server-selected detail locator; output and association pairing still use their own field contracts. */
export function captureReadKey(collection: Collection, key: unknown, keyField?: unknown) {
  const model = collection.model;
  if (model.primaryKeyAttributes.length !== 1) invalid('Detail reads require a single primary key');
  const primary = model.primaryKeyAttribute;
  const configured = keyField !== undefined;
  if (configured && (typeof keyField !== 'string' || keyField !== collection.filterTargetKey))
    invalid('Detail target key does not match the collection configuration');
  const field = configured ? (keyField as string) : primary;
  const attribute = Object.hasOwn(model.rawAttributes, field) ? model.rawAttributes[field] : undefined;
  const type = (attribute?.type as { key?: string } | undefined)?.key;
  const integer = !!type && ['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT'].includes(type);
  if (!type || (!integer && !['STRING', 'TEXT', 'UUID'].includes(type))) invalid('Unsupported detail target key type');
  let value: string;
  if (field === primary) value = normalizeKeys([key], collection)[0];
  else {
    if ((typeof key !== 'string' && typeof key !== 'number') || (typeof key === 'number' && !Number.isSafeInteger(key)))
      invalid('Invalid detail target key value');
    const text = String(key);
    if (!text || text.length > 512) invalid('Invalid detail target key length');
    if (integer) {
      if (!/^-?\d+$/.test(text)) invalid('Invalid integer detail target key');
      value = BigInt(text).toString();
    } else {
      if (typeof key !== 'string') invalid('String detail target keys must be strings');
      value = text;
    }
  }
  return {
    field,
    value,
    assertCurrent: () => {
      if (configured && collection.filterTargetKey !== field) invalid('Detail target key changed during query');
    },
  };
}
