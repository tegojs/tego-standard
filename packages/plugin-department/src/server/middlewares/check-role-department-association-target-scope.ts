import type { Context, Next } from '@tego/server';

export const checkRoleDepartmentAssociationTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName, values } = ctx.action.params;
  if (associatedName !== 'roles' || resourceName !== 'departments' || !['list', 'add', 'remove'].includes(actionName)) {
    return next();
  }
  const isTargetList = actionName === 'list';
  if (!isTargetList && (!Array.isArray(values) || values.length === 0)) {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'departments',
    action: 'list',
  });
  if (!permission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'departments', permission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  if (isTargetList) {
    ctx.action.params.filter = {
      $and: [filter, ctx.action.params.filter || {}],
    };
    return next();
  }

  const visibleDepartments = await ctx.db.getRepository('departments').find({
    filter: {
      $and: [filter, { id: { $in: values } }],
    },
    fields: ['id'],
  });
  const visibleDepartmentIds = new Set(visibleDepartments.map(({ id }) => String(id)));
  if (values.some((id) => !visibleDepartmentIds.has(String(id)))) {
    ctx.throw(403);
  }

  return next();
};
