import type { Context, Next } from '@tego/server';

const statusAssociations: Record<string, Record<string, string> | undefined> = {
  users: {
    statusInfo: 'status',
    previousStatusInfo: 'previousStatus',
  },
  userStatusHistories: {
    fromStatusInfo: 'fromStatus',
    toStatusInfo: 'toStatus',
  },
};

export const filterUserStatusAssociationReadScope = async (ctx: Context, next: Next) => {
  const { resourceName, actionName, appends } = ctx.action.params;
  const associations = statusAssociations[resourceName];
  if (!['list', 'get'].includes(actionName) || !Array.isArray(appends) || !associations) {
    return next();
  }
  const requestedAssociations = Object.entries(associations).filter(([name]) => appends.includes(name));
  if (!requestedAssociations.length) {
    return next();
  }

  const permission = ctx.tego.acl.can({
    role: ctx.state.currentRole,
    resource: 'userStatuses',
    action: 'list',
  });
  const visibleStatusKeys = new Set<string>();
  let visibleStatusFields: Set<string> | undefined;
  if (permission) {
    const aclParams = ctx.tego.acl.filterParams(ctx, 'userStatuses', permission.params || {});
    const { filter = {}, fields } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
    if (Array.isArray(fields)) {
      visibleStatusFields = new Set(fields);
    }
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
  const filterRow = (row) => {
    const result = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    for (const [association, foreignKey] of requestedAssociations) {
      if (
        result[association] != null &&
        !visibleStatusKeys.has(String(result[association].key ?? result[foreignKey]))
      ) {
        delete result[association];
      } else if (result[association] != null && visibleStatusFields) {
        result[association] = Object.fromEntries(
          Object.entries(result[association]).filter(([field]) => visibleStatusFields.has(field)),
        );
      }
    }
    return result;
  };

  if (Array.isArray(rows)) {
    ctx.body[rowsKey] = rows.map(filterRow);
  } else if (rows && typeof rows === 'object') {
    ctx.body[rowsKey] = filterRow(rows);
  } else if (typeof ctx.body?.toJSON === 'function') {
    ctx.body = filterRow(ctx.body);
  } else {
    return;
  }
};
