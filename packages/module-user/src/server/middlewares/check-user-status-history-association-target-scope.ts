import type { Context, Next } from '@tego/server';

export const checkUserStatusHistoryAssociationTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName, filter } = ctx.action.params;
  if (associatedName !== 'users' || resourceName !== 'statusHistories' || actionName !== 'list') {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'userStatusHistories',
    action: 'list',
  });
  if (!permission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'userStatusHistories', permission.params || {});
  const { filter: historyFilter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  ctx.action.params.filter = {
    $and: [historyFilter, filter || {}],
  };
  return next();
};
