import type { Application, Context, Next } from '@tego/server';

import { AccessConfigError } from '../access-control/config-errors';
import { inspectAccessConfig } from '../access-control/config-inspection';
import { AccessRuleError } from '../access-control/types';
import { translateTenantError } from '../locale';

function selection(input: unknown) {
  const invalid = (): never => {
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid access configuration selection');
  };
  if (
    !input ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length < 2 ||
    Reflect.ownKeys(input).length > 3
  )
    return invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    !['dataSourceKey', 'collectionName'].every(
      (name) =>
        Object.hasOwn(fields, name) &&
        Object.hasOwn(fields[name], 'value') &&
        typeof fields[name].value === 'string' &&
        fields[name].value.length > 0 &&
        fields[name].value.length <= 255,
    )
  )
    return invalid();
  if (
    Object.hasOwn(fields, 'collectionKey') &&
    (!Object.hasOwn(fields.collectionKey, 'value') ||
      typeof fields.collectionKey.value !== 'string' ||
      fields.collectionKey.value.length === 0 ||
      fields.collectionKey.value.length > 255)
  )
    return invalid();
  if (
    Reflect.ownKeys(fields).some(
      (name) => !['dataSourceKey', 'collectionName', 'collectionKey'].includes(name as string),
    )
  )
    return invalid();
  return {
    dataSourceKey: fields.dataSourceKey.value as string,
    collectionName: fields.collectionName.value as string,
    ...(typeof fields.collectionKey?.value === 'string' ? { collectionKey: fields.collectionKey.value } : {}),
  };
}

/** Control-plane read only; protected by the existing tenants management ACL. */
export function createAccessConfigRead(app: Application) {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.currentUser?.id == null) ctx.throw(401, translateTenantError(ctx, 'authenticationRequired'));
    if (ctx.method !== 'POST') ctx.throw(405);
    try {
      const request = selection(ctx.action.params.values);
      const { identity, config } = await inspectAccessConfig(app, request);
      if (request.collectionKey && request.collectionKey !== identity.collectionKey)
        throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'The collection changed during read', 409);
      ctx.body = { identity, config };
    } catch (error) {
      if (error instanceof AccessConfigError) {
        const key =
          error.code === 'ACCESS_CONFIG_CONFLICT'
            ? 'accessConfigReadConflict'
            : error.code === 'ACCESS_COLLECTION_NOT_FOUND'
              ? 'accessPreviewUnavailable'
              : 'accessConfigReadInvalid';
        ctx.throw(error.status, translateTenantError(ctx, key), { code: error.code });
      }
      if (error instanceof AccessRuleError)
        ctx.throw(400, translateTenantError(ctx, 'accessConfigReadInvalid'), { code: error.code });
      throw error;
    }
    await next();
  };
}
