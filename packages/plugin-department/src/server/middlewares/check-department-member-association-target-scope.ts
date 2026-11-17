import type { Context, Next } from '@tego/server';

export const checkDepartmentMemberAssociationTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName, values } = ctx.action.params;
  if (
    associatedName !== 'departments' ||
    resourceName !== 'members' ||
    actionName !== 'add' ||
    !Array.isArray(values) ||
    values.length === 0
  ) {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'users',
    action: 'add',
  });
  if (!permission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  const visibleUsers = await ctx.db.getRepository('users').find({
    filter: {
      $and: [filter, { id: { $in: values } }],
    },
    fields: ['id'],
  });
  const visibleUserIds = new Set(visibleUsers.map(({ id }) => String(id)));
  if (values.some((id) => !visibleUserIds.has(String(id)))) {
    ctx.throw(403);
  }

  return next();
};
