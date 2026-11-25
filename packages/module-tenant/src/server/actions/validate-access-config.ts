import type { Application, Context, Next } from '@tego/server';

import { AccessConfigError } from '../access-control/config-errors';
import { inspectAccessConfig } from '../access-control/config-inspection';
import { AccessRuleError } from '../access-control/types';
import { translateTenantError } from '../locale';

function invalid(): never {
  throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid access configuration validation request');
}

/** Copy bounded JSON before the first await, without evaluating accessors or sharing rule objects. */
export function snapshotAccessConfigRequest(input: unknown) {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 100000 || depth > 40) invalid();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > 10000) invalid();
      return value;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) invalid();
    const array = Array.isArray(value);
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      invalid();
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
    if (array && (value.length > 1000 || keys.length !== value.length)) invalid();
    seen.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 10000) invalid();
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    seen.delete(value);
    return result;
  };
  const values = copy(input);
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid();
  const params = values as Record<string, unknown>;
  const keys = Object.keys(params);
  const allowed = ['config', 'dataSourceKey', 'collectionName', 'collectionKey'];
  if (
    !Object.hasOwn(params, 'config') ||
    (keys.length !== 3 && keys.length !== 4) ||
    keys.some((key) => !allowed.includes(key))
  )
    invalid();
  for (const key of ['dataSourceKey', 'collectionName'])
    if (typeof params[key] !== 'string' || params[key].length === 0 || params[key].length > 255) invalid();
  if (
    Object.hasOwn(params, 'collectionKey') &&
    (typeof params.collectionKey !== 'string' || params.collectionKey.length === 0 || params.collectionKey.length > 255)
  )
    invalid();
  return {
    dataSourceKey: params.dataSourceKey as string,
    collectionName: params.collectionName as string,
    ...(typeof params.collectionKey === 'string' ? { collectionKey: params.collectionKey } : {}),
    config: params.config,
  };
}

/** Validation is not a save, activation decision or authorization lease. */
export function createAccessConfigValidation(app: Application) {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.currentUser?.id == null) ctx.throw(401, translateTenantError(ctx, 'authenticationRequired'));
    if (ctx.method !== 'POST') ctx.throw(405);
    try {
      const request = snapshotAccessConfigRequest(ctx.action.params.values);
      const { identity, validatedConfig } = await inspectAccessConfig(app, request, request.config);
      if (request.collectionKey && request.collectionKey !== identity.collectionKey)
        throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'The collection changed during validation', 409);
      ctx.body = { identity, config: validatedConfig };
    } catch (error) {
      if (error instanceof AccessConfigError) {
        const key =
          error.code === 'ACCESS_CONFIG_CONFLICT'
            ? 'accessConfigReadConflict'
            : error.code === 'ACCESS_COLLECTION_NOT_FOUND'
              ? 'accessPreviewUnavailable'
              : 'accessConfigValidationInvalid';
        ctx.throw(error.status, translateTenantError(ctx, key), { code: error.code });
      }
      if (error instanceof AccessRuleError)
        ctx.throw(400, translateTenantError(ctx, 'accessConfigValidationInvalid'), { code: error.code });
      throw error;
    }
    await next();
  };
}
