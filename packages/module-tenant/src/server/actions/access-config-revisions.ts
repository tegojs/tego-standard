import type { Application, Context, Next } from '@tego/server';

import { AccessConfigError } from '../access-control/config-errors';
import { inspectAccessConfig, type AccessConfigRevisionInspection } from '../access-control/config-inspection';
import { AccessRuleError } from '../access-control/types';
import { translateTenantError } from '../locale';

function selection(input: unknown, type: 'list' | 'draft') {
  const invalid = (): never => {
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid access revision selection');
  };
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  const allowed = [
    'dataSourceKey',
    'collectionName',
    ...(type === 'list' ? ['limit', 'beforeRevision'] : ['revision']),
  ];
  for (const key of Reflect.ownKeys(fields)) {
    if (
      typeof key !== 'string' ||
      !allowed.includes(key) ||
      !Object.hasOwn(fields[key], 'value') ||
      !fields[key].enumerable
    )
      invalid();
  }
  const dataSourceKey = fields.dataSourceKey?.value;
  const collectionName = fields.collectionName?.value;
  if (
    ![dataSourceKey, collectionName].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 255,
    )
  )
    invalid();
  const positive = (name: string) => {
    const value = fields[name]?.value;
    if (!Number.isSafeInteger(value) || value < 1) invalid();
    return value as number;
  };
  let revisionRequest: AccessConfigRevisionInspection;
  if (type === 'draft') revisionRequest = { type, revision: positive('revision') };
  else {
    const limit = Object.hasOwn(fields, 'limit') ? positive('limit') : 20;
    if (limit > 100) invalid();
    revisionRequest = {
      type,
      limit,
      ...(Object.hasOwn(fields, 'beforeRevision') ? { beforeRevision: positive('beforeRevision') } : {}),
    };
  }
  return { dataSourceKey: dataSourceKey as string, collectionName: collectionName as string, revisionRequest };
}

/** Read-only management actions. No audit model installation, save, migration or activation. */
export function createAccessConfigRevisions(app: Application, type: 'list' | 'draft') {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.currentUser?.id == null) ctx.throw(401, translateTenantError(ctx, 'authenticationRequired'));
    if (ctx.method !== 'POST') ctx.throw(405);
    try {
      const request = selection(ctx.action.params.values, type);
      const { identity, validatedConfig, revisionPage, sourceRevision } = await inspectAccessConfig(
        app,
        request,
        undefined,
        request.revisionRequest,
      );
      ctx.body =
        type === 'list' ? { identity, ...revisionPage } : { identity, sourceRevision, config: validatedConfig };
    } catch (error) {
      if (error instanceof AccessConfigError) {
        const key =
          error.code === 'ACCESS_CONFIG_CONFLICT'
            ? 'accessConfigReadConflict'
            : error.code === 'ACCESS_COLLECTION_NOT_FOUND'
              ? 'accessRevisionUnavailable'
              : 'accessRevisionInvalid';
        ctx.throw(error.status, translateTenantError(ctx, key), { code: error.code });
      }
      if (error instanceof AccessRuleError)
        ctx.throw(400, translateTenantError(ctx, 'accessConfigValidationInvalid'), { code: error.code });
      throw error;
    }
    await next();
  };
}
