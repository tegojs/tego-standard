import type { Application, Context, Next } from '@tego/server';

import { AccessConfigError } from '../access-control/config-errors';
import { inspectAccessConfig } from '../access-control/config-inspection';
import { AccessRuleError } from '../access-control/types';
import { translateTenantError } from '../locale';
import { snapshotAccessConfigRequest } from './validate-access-config';

/** Persist a validated, audited configuration revision; business activation remains a separate rollout step. */
export function createAccessConfigSave(app: Application) {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.currentUser?.id == null) ctx.throw(401, translateTenantError(ctx, 'authenticationRequired'));
    if (ctx.method !== 'POST') ctx.throw(405);
    try {
      const request = snapshotAccessConfigRequest(ctx.action.params.values);
      const inspected = await inspectAccessConfig(app, request, request.config);
      if (!request.collectionKey || request.collectionKey !== inspected.identity.collectionKey) {
        throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'The collection changed; reload before saving', 409);
      }
      if (!inspected.validatedConfig) {
        throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Validated configuration is unavailable');
      }
      const config = await inspected.store.save(inspected.identity, inspected.validatedConfig, {
        userId: ctx.state.currentUser.id,
      });
      ctx.body = { identity: inspected.identity, config };
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
