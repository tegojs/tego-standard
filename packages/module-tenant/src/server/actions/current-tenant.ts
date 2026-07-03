import type { Context, Next } from '@tego/server';

function toPublicTenant(tenant: any) {
  if (!tenant) {
    return null;
  }

  return {
    id: tenant.id,
    name: tenant.name,
    title: tenant.title,
  };
}

export async function currentTenant(ctx: Context, next: Next) {
  ctx.body = toPublicTenant(ctx.state.currentTenant);
  await next();
}

export default currentTenant;
