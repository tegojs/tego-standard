import type { Context, Next } from '@tego/server';

export const denyUserStatusHistoryCreate = async (ctx: Context, next: Next) => {
  const { resourceName, actionName } = ctx.action.params;
  if (resourceName === 'userStatusHistories' && actionName === 'create') {
    ctx.throw(403);
  }
  return next();
};
