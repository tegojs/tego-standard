import { invalid, plain } from './write-support';

export type AccessAggregateOrder =
  | { readonly by: 'value'; readonly index?: number; readonly direction: 'asc' | 'desc' }
  | { readonly by: 'field'; readonly field: string; readonly direction: 'asc' | 'desc' };

/** Capture before resolving permissions; identifiers are checked against authorized groups by the reader. */
export function captureAggregateOrder(input: unknown, measureCount = 1): AccessAggregateOrder[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > measureCount + 3 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Aggregate order must be a bounded dense array');
  const result: AccessAggregateOrder[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    const item: unknown = descriptor?.value;
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !plain(item) ||
      !Object.hasOwn(item, 'by') ||
      !Object.hasOwn(item, 'direction') ||
      Reflect.ownKeys(item).some(
        (key) =>
          typeof key !== 'string' ||
          !['by', 'field', 'direction', 'index'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key)!, 'value'),
      )
    )
      invalid('Unsupported aggregate order descriptor');
    const { by, field, direction } = item;
    const measureIndex = item.index === undefined ? 0 : item.index;
    if (
      (by !== 'field' && by !== 'value') ||
      (direction !== 'asc' && direction !== 'desc') ||
      (by === 'value'
        ? Object.hasOwn(item, 'field') ||
          typeof measureIndex !== 'number' ||
          !Number.isSafeInteger(measureIndex) ||
          measureIndex < 0 ||
          measureIndex >= measureCount
        : Object.hasOwn(item, 'index') ||
          !Object.hasOwn(item, 'field') ||
          typeof field !== 'string' ||
          !field.length ||
          field.length > 255)
    )
      invalid('Aggregate order requires a field or value and a supported direction');
    const key = by === 'value' ? `value:${measureIndex}` : `field:${field}`;
    if (seen.has(key)) invalid('Aggregate order targets must be distinct');
    seen.add(key);
    result.push(
      by === 'value' ? { by, index: measureIndex as number, direction } : { by, field: field as string, direction },
    );
  }
  return result;
}
