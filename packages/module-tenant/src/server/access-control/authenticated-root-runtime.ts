import type { Context, Resourcer } from '@tego/server';

import type { AccessCollectionIdentity } from './config-store';
import type { AccessRootResourceRuntime } from './root-resource-runtime';

export interface AccessRootRuntimeSelection {
  runtime: AccessRootResourceRuntime;
  identities: readonly AccessCollectionIdentity[];
}

export type AccessRootRuntimeProvider = (ctx: Context) => Promise<AccessRootRuntimeSelection>;

/** Explicit installation only; the tenant plugin does not enable this runtime. */
export function registerAuthenticatedAccessRootRuntime(
  resourcer: Resourcer,
  runtime: AccessRootResourceRuntime | AccessRootRuntimeProvider,
  identities: readonly AccessCollectionIdentity[] = [],
): void {
  const selected = identities.map((identity) => ({ ...identity }));
  const requests = new WeakMap<object, AccessRootResourceRuntime>();
  resourcer.use(
    async (ctx: Context, next) => {
      const actor = {
        userId: ctx.state.currentUser?.id,
        tenantId: ctx.state.currentTenantId,
        roleName: ctx.state.currentRole,
      };
      const selection = typeof runtime === 'function' ? await runtime(ctx) : { runtime, identities: selected };
      requests.set(ctx, selection.runtime);
      try {
        await selection.runtime.prepare(ctx, actor, selection.identities, next);
      } finally {
        requests.delete(ctx);
      }
    },
    {
      tag: 'tenantAccessRootPreparation',
      after: ['auth', 'setCurrentRole', 'setCurrentTenant'],
      before: ['tenantAssociationReadPlaceholder', 'acl'],
    },
  );
  resourcer.use((ctx: Context, next) => requests.get(ctx)?.dispatch(ctx, next) ?? next(), {
    tag: 'tenantAccessRootDispatch',
    after: ['acl', 'importXlsx'],
    before: ['tenantResourceGuard', 'dataSource'],
  });
}
