import type { Context, Next } from '@tego/server';

import _ from 'lodash';

const checkOwnerUsersScope = async (ctx: Context, departmentId, owners) => {
  const memberships = await ctx.db.getRepository('departmentsUsers').find({
    filter: { departmentId },
    fields: ['userId'],
    raw: true,
  });
  const userIds = [
    ...new Map(
      [...memberships.map(({ userId }) => userId), ...owners.map(({ id }) => id)].map((id) => [String(id), id]),
    ).values(),
  ];
  if (!userIds.length) {
    return;
  }

  const permission = ctx.can({ resource: 'users', action: 'list' });
  if (!permission) {
    ctx.throw(403);
  }
  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
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
};

const setOwners = async (ctx: Context, filterByTk, owners) => {
  const throughRepo = ctx.db.getRepository('departmentsUsers');
  await ctx.db.sequelize.transaction(async (t) => {
    await throughRepo.update({
      filter: {
        departmentId: filterByTk,
      },
      values: {
        isOwner: false,
      },
      transaction: t,
    });
    await throughRepo.update({
      filter: {
        departmentId: filterByTk,
        userId: {
          $in: owners.map((owner) => owner.id),
        },
      },
      values: {
        isOwner: true,
      },
      transaction: t,
    });
  });
};
export const setDepartmentOwners = async (ctx: Context, next: Next) => {
  const { filterByTk, values = {}, resourceName, actionName } = ctx.action.params;
  const { owners } = values;
  if (resourceName === 'departments' && actionName === 'update' && owners) {
    const { whitelist, filter } = ctx.action.params;
    const canChangeOwners = !whitelist || whitelist.includes('owners');
    if (canChangeOwners) {
      const department = await ctx.db.getRepository('departments').findOne({ filterByTk, filter });
      if (department) {
        await checkOwnerUsersScope(ctx, department.id, owners);
      }
    }
    ctx.action.params.values = _.omit(values, ['owners']);
    await next();
    const updatedDepartments = ctx.body;
    const updatedTarget =
      Array.isArray(updatedDepartments) &&
      updatedDepartments.some((department) => String(department.id) === String(filterByTk));
    if (updatedTarget && canChangeOwners) {
      await setOwners(ctx, filterByTk, owners);
    }
  } else {
    return next();
  }
};
