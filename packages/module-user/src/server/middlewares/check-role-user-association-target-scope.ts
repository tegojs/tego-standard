import type { Context, Next } from '@tego/server';

export const checkRoleUserAssociationTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName } = ctx.action.params;
  if (associatedName !== 'roles' || resourceName !== 'users' || actionName !== 'list') {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'users',
    action: 'list',
  });
  if (!permission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  ctx.action.params.filter = {
    $and: [filter, ctx.action.params.filter || {}],
  };
  return next();
};
