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
