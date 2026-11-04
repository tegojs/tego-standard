import type { Context, Resourcer } from '@tego/server';

import type { AccessCollectionIdentity } from './config-store';
import type { AccessRootResourceRuntime } from './root-resource-runtime';

/** Explicit installation only; the tenant plugin does not enable this runtime. */
export function registerAuthenticatedAccessRootRuntime(
  resourcer: Resourcer,
  runtime: AccessRootResourceRuntime,
  identities: readonly AccessCollectionIdentity[],
): void {
  const selected = identities.map((identity) => ({ ...identity }));
  resourcer.use(
    async (ctx: Context, next) => {
      await runtime.prepare(
        ctx,
        {
          userId: ctx.state.currentUser?.id,
          tenantId: ctx.state.currentTenantId,
          roleName: ctx.state.currentRole,
        },
        selected,
        next,
      );
    },
    {
      tag: 'tenantAccessRootPreparation',
      after: ['auth', 'setCurrentRole', 'setCurrentTenant'],
      before: 'acl',
    },
  );
  resourcer.use((ctx: Context, next) => runtime.dispatch(ctx, next), {
    tag: 'tenantAccessRootDispatch',
    after: 'acl',
    before: ['tenantResourceGuard', 'dataSource'],
  });
}
