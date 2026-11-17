import type { Context, Next } from '@tego/server';

export const checkUserCreateRoleTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName, values, whitelist, blacklist } = ctx.action.params;
  if (associatedName || resourceName !== 'users' || actionName !== 'create') {
    return next();
  }
  if ((whitelist && !whitelist.includes('roles')) || blacklist?.includes('roles')) {
    return next();
  }

  const records = Array.isArray(values) ? values : [values];
  const requestedRoles = records.flatMap((record) => {
    if (record?.roles == null) {
      return [];
    }
    return Array.isArray(record.roles) ? record.roles : [record.roles];
  });
  if (!requestedRoles.length) {
    return next();
  }

  const roleNames = requestedRoles.map((role) => {
    const name = typeof role === 'string' ? role : role?.name;
    if (typeof name !== 'string' || !name) {
      ctx.throw(403);
    }
    return name;
  });
  const rolesPermission = ctx.can({ resource: 'roles', action: 'list' });
  if (!rolesPermission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'roles', rolesPermission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  const visibleRoles = await ctx.db.getRepository('roles').find({
    filter: {
      $and: [filter, { name: { $in: roleNames } }],
    },
    fields: ['name'],
  });
  const visibleRoleNames = new Set(visibleRoles.map(({ name }) => name));
  if (roleNames.some((name) => !visibleRoleNames.has(name))) {
    ctx.throw(403);
  }

  return next();
};
