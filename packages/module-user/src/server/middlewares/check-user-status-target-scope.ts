import type { Context, Next } from '@tego/server';

export const checkUserStatusTargetScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, actionName, values, whitelist, blacklist, filterByTk, filter } =
    ctx.action.params;
  if (associatedName || resourceName !== 'users' || !['create', 'update'].includes(actionName)) {
    return next();
  }
  const statusFields = ['status', 'previousStatus', 'statusInfo', 'previousStatusInfo'].filter(
    (field) => (!whitelist || whitelist.includes(field)) && !blacklist?.includes(field),
  );

  const records = Array.isArray(values) ? values : [values];
  const statusKeys = records.flatMap((record) =>
    statusFields.flatMap((field) => {
      const value = record?.[field];
      if (value == null) {
        return [];
      }
      return [field.endsWith('Info') && typeof value === 'object' ? value.key : value];
    }),
  );
  if (!statusKeys.length) {
    return next();
  }

  if (actionName === 'update') {
    const user = await ctx.db.getRepository('users').findOne({ filterByTk, filter, fields: ['id'] });
    if (!user) {
      return next();
    }
  }

  if (statusKeys.some((key) => typeof key !== 'string' || !key)) {
    ctx.throw(403);
  }
  const statusPermission = ctx.can({ resource: 'userStatuses', action: 'list' });
  if (!statusPermission) {
    ctx.throw(403);
  }

  const aclParams = ctx.tego.acl.filterParams(ctx, 'userStatuses', statusPermission.params || {});
  const { filter: statusFilter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  const visibleStatuses = await ctx.db.getRepository('userStatuses').find({
    filter: {
      $and: [statusFilter, { key: { $in: statusKeys } }],
    },
    fields: ['key'],
  });
  const visibleStatusKeys = new Set(visibleStatuses.map(({ key }) => key));
  if (statusKeys.some((key) => !visibleStatusKeys.has(key))) {
    ctx.throw(403);
  }

  return next();
};
