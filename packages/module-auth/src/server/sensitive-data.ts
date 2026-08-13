import { Model } from '@tego/server';

const AUTHENTICATION_SECRET_KEYS = new Set(['password', 'resetToken']);

export function isAuthenticationSecretKey(key: unknown): boolean {
  return typeof key === 'string' && AUTHENTICATION_SECRET_KEYS.has(key);
}

function isSensitiveKeyValueEntry(value: unknown) {
  if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'value')) {
    return false;
  }
  const key = Reflect.get(value, 'key');
  return typeof key === 'string' && key.split('.').some(isAuthenticationSecretKey);
}

function redact(value: any, seen: WeakMap<object, any>): any {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (seen.has(value)) {
    return seen.get(value);
  }

  let serialized = value;
  if (value instanceof Model) {
    try {
      serialized = value.get({ plain: true });
    } catch {
      serialized = value.dataValues;
    }
  }
  if (serialized === null || typeof serialized !== 'object') {
    seen.set(value, serialized);
    return serialized;
  }
  if (serialized instanceof Date) {
    const result = new Date(serialized.getTime());
    seen.set(value, result);
    return result;
  }

  const result: any = Array.isArray(serialized) ? [] : {};
  seen.set(value, result);
  seen.set(serialized, result);
  if (Array.isArray(serialized)) {
    for (const item of serialized) {
      if (!isSensitiveKeyValueEntry(item)) {
        result.push(redact(item, seen));
      }
    }
    return result;
  }
  for (const key of Reflect.ownKeys(serialized)) {
    if (isAuthenticationSecretKey(key)) {
      continue;
    }
    if (key === 'toJSON' && typeof serialized[key] === 'function') {
      continue;
    }
    result[key] = redact(serialized[key], seen);
  }
  return result;
}

export function redactSensitiveAuthenticationData<T>(value: T): T {
  return redact(value, new WeakMap());
}

export function serializeAuthenticatedUser(user: any) {
  const password = user?.get?.('password') ?? user?.password;
  const hasPassword =
    password === undefined
      ? (user?.get?.('hasPassword') ?? user?.hasPassword ?? false)
      : typeof password === 'string'
        ? password.length > 0
        : password != null;
  return {
    ...redactSensitiveAuthenticationData(user ?? {}),
    hasPassword,
  };
}
