import type { Context, Next } from '@tego/server';

const statusAssociations = {
  statusInfo: 'status',
  previousStatusInfo: 'previousStatus',
};

export const filterUserStatusAssociationReadScope = async (ctx: Context, next: Next) => {
  const { resourceName, actionName, appends } = ctx.action.params;
  if (
    resourceName !== 'users' ||
    actionName !== 'list' ||
    !Array.isArray(appends) ||
    !appends.some((name) => Object.hasOwn(statusAssociations, name))
  ) {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'userStatuses',
    action: 'list',
  });
  const visibleStatusKeys = new Set<string>();
  if (permission) {
    const aclParams = ctx.tego.acl.filterParams(ctx, 'userStatuses', permission.params || {});
    const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
    const statuses = await ctx.db.getRepository('userStatuses').find({
      filter,
      fields: ['key'],
    });
    for (const { key } of statuses) {
      visibleStatusKeys.add(String(key));
    }
  }
  await next();

  const rowsKey = Array.isArray(ctx.body?.rows) ? 'rows' : 'data';
  const rows = ctx.body?.[rowsKey];
  if (!Array.isArray(rows)) {
    return;
  }

  ctx.body[rowsKey] = rows.map((row) => {
    const result = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    for (const [association, foreignKey] of Object.entries(statusAssociations)) {
      if (
        appends.includes(association) &&
        result[association] != null &&
        !visibleStatusKeys.has(String(result[association].key ?? result[foreignKey]))
      ) {
        delete result[association];
      }
    }
    return result;
  });
};
