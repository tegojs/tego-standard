import type { Collection, Database } from '@tego/server';

import { invalid } from './write-support';

/** Capture syntax before metadata or permission callbacks can run. This does not authorize any field. */
export function captureAccessSortFields(input: unknown) {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 20 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Sort fields require a bounded dense list');
  const fields: Array<{ parts: string[]; direction: 'ASC' | 'DESC' }> = [];
  const unique = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Sort fields cannot contain accessors or gaps');
    const value: unknown = descriptor.value;
    if (typeof value !== 'string' || !value || value.length > 512) invalid('Sort fields must be bounded strings');
    const descending = value.startsWith('-');
    const field = descending ? value.slice(1) : value;
    const parts = field.split('.');
    if (
      parts.length > 4 ||
      parts.some(
        (part) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part),
      ) ||
      unique.has(field)
    )
      invalid('Sort field path is invalid, repeated or exceeds depth limit');
    unique.add(field);
    fields.push({ parts, direction: descending ? 'DESC' : 'ASC' });
  }
  return fields;
}

export function resolveAccessSortTarget(db: Database, source: Collection['model'], name: string): Collection {
  const association = source.associations[name];
  const target = association && db.modelCollection.get(association.target);
  if (!target || association.associationType !== 'BelongsTo' || target.model === source)
    invalid('Sort paths support only distinct registered BelongsTo models');
  return target;
}

export function assertAccessSortScalarField(model: Collection['model'], field: string): void {
  const attribute = Object.hasOwn(model.rawAttributes, field) ? model.rawAttributes[field] : undefined;
  const type = (attribute?.type as { key?: string } | undefined)?.key;
  if (
    !attribute ||
    ![
      'STRING',
      'CHAR',
      'TEXT',
      'UUID',
      'ENUM',
      'CITEXT',
      'INTEGER',
      'BIGINT',
      'SMALLINT',
      'TINYINT',
      'MEDIUMINT',
      'DECIMAL',
      'FLOAT',
      'DOUBLE',
      'REAL',
      'BOOLEAN',
      'DATE',
      'DATEONLY',
    ].includes(type!)
  )
    invalid('Sort requires an authorized physical scalar field');
}
