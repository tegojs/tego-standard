import type { Context, Next } from '@tego/server';

type PublicTenantSource = {
  id: string;
  name?: string;
  title?: string;
};

function toPublicTenant(tenant: PublicTenantSource | null | undefined) {
  if (!tenant) {
    return null;
  }

  return {
    id: tenant.id,
    name: tenant.name,
    title: tenant.title,
  };
}

/**
 * Returns the public shape of the tenant bound to the current request.
 */
export async function currentTenant(ctx: Context, next: Next) {
  ctx.body = toPublicTenant(ctx.state.currentTenant);
  await next();
}

export default currentTenant;
