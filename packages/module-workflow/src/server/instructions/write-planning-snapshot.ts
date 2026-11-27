function sameDescriptor(left?: PropertyDescriptor, right?: PropertyDescriptor) {
  if (!left || !right) return left === right;
  return (
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable &&
    left.writable === right.writable &&
    left.get === right.get &&
    left.set === right.set &&
    Object.is(left.value, right.value)
  );
}

/** Transaction planning needs field names, never the corresponding business values or actor. */
export function captureWorkflowWriteValueFields(params: object): readonly string[] {
  const descriptor = Object.getOwnPropertyDescriptor(params, 'values');
  if (!descriptor) return Object.freeze([]);
  if (
    !Object.hasOwn(descriptor, 'value') ||
    !descriptor.value ||
    typeof descriptor.value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(descriptor.value))
  )
    throw new TypeError('Workflow planning requires ordinary field values');
  return Object.freeze(Object.keys(descriptor.value));
}

/** Detached, bounded JSON for selection planning; never expose mutable instruction inputs. */
export function captureWorkflowWriteSelectionFilter(params: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(params, 'filter');
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Workflow selection filters cannot contain accessors');
  if (descriptor.value === undefined) return;
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 1000 || depth > 16) throw new TypeError('Workflow selection filter exceeds size or depth limits');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 10000) return value;
    if (!value || typeof value !== 'object') throw new TypeError('Workflow selection filters require bounded JSON');
    if (seen.has(value)) throw new TypeError('Workflow selection filters cannot contain cycles');
    seen.add(value);
    const array = Array.isArray(value);
    const keys = Reflect.ownKeys(value);
    if (array) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 100 ||
        keys.length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean)
      )
        throw new TypeError('Workflow selection filter lists must be bounded and dense');
    } else if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError('Workflow selection filters require plain JSON objects');
    }
    const result = array ? [] : Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 10000 || key.split('.').length > 10)
        throw new TypeError('Workflow selection filter keys exceed supported limits');
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(property, 'value')) throw new TypeError('Workflow selection filters cannot contain accessors');
      result[key] = copy(property.value, depth + 1);
    }
    seen.delete(value);
    return Object.freeze(result);
  };
  return copy(descriptor.value);
}

/** Observe resolved data properties without copying model/context internals or evaluating getters. */
export function captureWorkflowWritePlanningInputs(params: object, context: object) {
  const checks: Array<() => boolean> = [];
  const seen = new WeakSet<object>();
  let size = 0;
  const capture = (value: unknown, depth = 0, names?: string[]) => {
    if (!value || typeof value !== 'object' || (!names && seen.has(value))) return;
    if (depth > 32) throw new TypeError('Workflow planning inputs exceed the depth limit');
    if (!names) seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    const keys = names ?? Reflect.ownKeys(value);
    size += keys.length;
    if (size > 10000) throw new TypeError('Workflow planning inputs exceed the size limit');
    const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(value, key));
    checks.push(
      () =>
        Object.getPrototypeOf(value) === prototype &&
        (names !== undefined || Reflect.ownKeys(value).length === keys.length) &&
        keys.every((key, index) => sameDescriptor(descriptors[index], Object.getOwnPropertyDescriptor(value, key))),
    );
    if (!names) {
      if (value instanceof Date) {
        const time = Date.prototype.getTime.call(value);
        checks.push(() => Object.is(Date.prototype.getTime.call(value), time));
      }
      for (const descriptor of descriptors) {
        if (descriptor && Object.hasOwn(descriptor, 'value')) capture(descriptor.value, depth + 1);
      }
    }
  };
  capture(params);
  capture(context, 0, ['state']);
  const state = Object.getOwnPropertyDescriptor(context, 'state');
  if (state && Object.hasOwn(state, 'value'))
    capture(state.value, 0, ['currentTenantId', 'currentUserId', 'currentRole']);
  return () => {
    if (!checks.every((check) => check())) throw new TypeError('Workflow inputs changed during planning');
  };
}
