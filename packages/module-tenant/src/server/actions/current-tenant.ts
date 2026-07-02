import type { Context, Next } from '@tego/server';

export async function currentTenant(ctx: Context, next: Next) {
  ctx.body = ctx.state.currentTenant || null;
  await next();
}

export default currentTenant;
