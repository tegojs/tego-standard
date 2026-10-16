import { invalid } from './write-support';

/** Capture bounded JSON without invoking input accessors or sharing mutable values. */
export function captureAccessFilter(input: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 1000 || depth > 16) invalid('Request filter exceeds size or depth limit');
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) invalid('Request filter contains a non-finite number');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > 10000) invalid('Request filter string exceeds size limit');
      return value;
    }
    if (!value || typeof value !== 'object') invalid('Request filters must be JSON values');
    if (seen.has(value)) invalid('Request filters cannot contain cycles');
    seen.add(value);
    if (Array.isArray(value)) {
      if (
        value.length > 100 ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean)
      )
        invalid('Request filter lists must be bounded and dense');
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)!;
        if (!Object.hasOwn(descriptor, 'value')) invalid('Request filters cannot contain accessors');
        result.push(copy(descriptor.value, depth + 1));
      }
      seen.delete(value);
      return result;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      invalid('Request filter objects must be plain JSON objects');
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') invalid('Request filter keys must be strings');
      if (key.length > 10000) invalid('Request filter key exceeds size limit');
      if (key.split('.').length > 10) invalid('Request filter path exceeds depth limit');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, 'value')) invalid('Request filters cannot contain accessors');
      result[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return result;
  };
  return copy(input);
}
