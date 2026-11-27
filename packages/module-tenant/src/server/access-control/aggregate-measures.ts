import { invalid, plain } from './write-support';

export type AggregateMethod = 'avg' | 'count' | 'min' | 'max' | 'sum';
export interface AccessAggregateMeasure {
  readonly field: string;
  readonly method: AggregateMethod;
  readonly distinct: boolean;
}

/** Snapshot the bounded measure list without invoking request accessors or permission callbacks. */
export function captureAggregateMeasures(input: unknown): AccessAggregateMeasure[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    !input.length ||
    input.length > 10 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Select one to ten aggregate measures in a dense array');
  const result: AccessAggregateMeasure[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    const item: unknown = descriptor?.value;
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !plain(item) ||
      !Object.hasOwn(item, 'field') ||
      !Object.hasOwn(item, 'method') ||
      Reflect.ownKeys(item).some(
        (key) =>
          typeof key !== 'string' ||
          !['field', 'method', 'distinct'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key)!, 'value'),
      )
    )
      invalid('Unsupported aggregate measure descriptor');
    const { field, method, distinct } = item;
    if (
      typeof field !== 'string' ||
      !field.length ||
      field.length > 255 ||
      typeof method !== 'string' ||
      !['avg', 'count', 'min', 'max', 'sum'].includes(method) ||
      (distinct !== undefined && typeof distinct !== 'boolean')
    )
      invalid('Aggregate measures require a field, supported method and boolean distinct');
    result.push({ field, method: method as AggregateMethod, distinct: distinct === true });
  }
  return result;
}
