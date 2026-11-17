import type { Context, Next } from '@tego/server';

export const checkRoleUserAssociationTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName, filterByTk, filterByTks, values } = ctx.action.params;
  const isTargetList = actionName === 'list';
  if (associatedName !== 'roles' || resourceName !== 'users' || !['list', 'add', 'remove'].includes(actionName)) {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'users',
    action: actionName,
  });
  if (!permission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  if (isTargetList) {
    ctx.action.params.filter = {
      $and: [filter, ctx.action.params.filter || {}],
    };
    return next();
  }

  const targets = filterByTk || filterByTks || values || [];
  const userIds = Array.isArray(targets) ? targets : [targets];
  const visibleUsers = await ctx.db.getRepository('users').find({
    filter: {
      $and: [filter, { id: { $in: userIds } }],
    },
    fields: ['id'],
  });
  const visibleUserIds = new Set(visibleUsers.map(({ id }) => String(id)));
  if (userIds.some((id) => !visibleUserIds.has(String(id)))) {
    ctx.throw(403);
  }

  return next();
};
