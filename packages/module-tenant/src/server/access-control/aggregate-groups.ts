import type { Database } from '@tego/server';

import { normalizeDateFilterTimezone } from './date-filter';
import { invalid, plain } from './write-support';

export type AggregateDateFormat = 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD';
export interface AccessAggregateGroup {
  readonly field: string;
  readonly format?: AggregateDateFormat;
  readonly timezone?: string;
}

export function isAggregateDateFormat(input: unknown): input is AggregateDateFormat {
  return input === 'YYYY' || input === 'YYYY-MM' || input === 'YYYY-MM-DD';
}

/** Snapshot raw fields or date descriptors before permission callbacks and asynchronous work. */
export function captureAggregateGroups(input: unknown, allowEmpty: boolean): AccessAggregateGroup[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    (!allowEmpty && !input.length) ||
    input.length > 3 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Select up to three distinct authorized scalar grouping fields');
  const result: AccessAggregateGroup[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Grouping cannot contain accessors or holes');
    const item: unknown = descriptor.value;
    let group: AccessAggregateGroup;
    if (typeof item === 'string') group = { field: item };
    else {
      if (
        !plain(item) ||
        Reflect.ownKeys(item).length !== 3 ||
        ['field', 'format', 'timezone'].some((key) => {
          const property = Object.getOwnPropertyDescriptor(item, key);
          return !property || !Object.hasOwn(property, 'value');
        }) ||
        typeof item.field !== 'string' ||
        !isAggregateDateFormat(item.format)
      )
        invalid('Date grouping requires a field, supported format and explicit timezone');
      group = { field: item.field, format: item.format, timezone: normalizeDateFilterTimezone(item.timezone) };
    }
    if (!group.field.length || group.field.length > 255 || result.some(({ field }) => field === group.field))
      invalid('Grouping requires distinct authorized physical scalar fields');
    result.push(group);
  }
  return result;
}

/** column is server-quoted and type is verified against the actual authorized model attribute. */
export function aggregateGroupExpression(
  db: Database,
  column: string,
  group: AccessAggregateGroup,
  type: string,
): string {
  if (!group.format) return column;
  if (type !== 'DATE' && type !== 'DATEONLY') invalid('Date grouping requires an authorized physical date field');
  const zone = group.timezone!;
  const minutes = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone[0] === '-' ? -1 : 1);
  switch (db.sequelize.getDialect()) {
    case 'sqlite': {
      const format = group.format.replace('YYYY', '%Y').replace('MM', '%m').replace('DD', '%d');
      return `strftime(${db.sequelize.escape(format)}, ${column}${type === 'DATE' ? `, '${minutes} minutes'` : ''})`;
    }
    case 'postgres': {
      const value = type === 'DATE' ? `((${column} AT TIME ZONE 'UTC') + ${minutes} * INTERVAL '1 minute')` : column;
      return `to_char(${value}, ${db.sequelize.escape(group.format)})`;
    }
    default:
      return invalid('Date grouping is unsupported for this database');
  }
}
