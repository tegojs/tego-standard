import type { Context, Next } from '@tego/server';

export const getAppendsOwners = async (ctx: Context, next: Next) => {
  const { filterByTk, appends } = ctx.action.params;
  const repo = ctx.db.getRepository('departments');
  const department = await repo.findOne({
    filterByTk,
    appends,
  });
  const owners = await department.getOwners();
  department.setDataValue('owners', owners);
  ctx.body = department;
  await next();
};
export const aggregateSearch = async (ctx: Context, next: Next) => {
  const { keyword, type, last = 0, limit = 10 } = ctx.action.params.values || {};
  let users = [];
  let departments = [];
  if (!type || type === 'user') {
    const permission = ctx.can({ resource: 'users', action: 'list' });
    if (permission) {
      const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
      const { filter = {}, fields } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
      const repo = ctx.db.getRepository('users');
      users = await repo.find({
        filter: {
          $and: [
            filter,
            {
              id: { $gt: last },
              $or: [
                { username: { $includes: keyword } },
                { nickname: { $includes: keyword } },
                { phone: { $includes: keyword } },
                { email: { $includes: keyword } },
              ],
            },
          ],
        },
        fields,
        limit,
      });
    }
  }
  if (!type || type === 'department') {
    const repo = ctx.db.getRepository('departments');
    const departmentFilter = ctx.action.params.filter || {};
    departments = await repo.find({
      filter: {
        $and: [
          departmentFilter,
          {
            id: { $gt: last },
            title: { $includes: keyword },
          },
        ],
      },
      appends: Object.keys(departmentFilter).length ? [] : ['parent(recursively=true)'],
      limit,
    });
  }
  ctx.body = { users, departments };
  await next();
};
const canManageDepartment = async (ctx: Context, departmentId) => {
  const { filter } = ctx.action.params;
  const department = await ctx.db.getRepository('departments').findOne({
    filterByTk: departmentId,
    filter,
  });
  return Boolean(department);
};
const canAccessOwnerUser = async (ctx: Context, userId) => {
  const permission = ctx.can({ resource: 'users', action: 'list' });
  if (!permission) {
    return false;
  }
  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  const user = await ctx.db.getRepository('users').findOne({ filterByTk: userId, filter });
  return Boolean(user);
};
export const setOwner = async (ctx: Context, next: Next) => {
  const { userId, departmentId } = ctx.action.params.values || {};
  if (userId === undefined || departmentId === undefined) {
    ctx.throw(400, ctx.t('User and department are required', { ns: 'departments' }));
  }
  if (await canManageDepartment(ctx, departmentId)) {
    if (!(await canAccessOwnerUser(ctx, userId))) {
      ctx.throw(403);
    }
    const throughRepo = ctx.db.getRepository('departmentsUsers');
    await throughRepo.update({
      filter: {
        userId,
        departmentId,
      },
      values: {
        isOwner: true,
      },
    });
  }
  await next();
};
export const removeOwner = async (ctx: Context, next: Next) => {
  const { userId, departmentId } = ctx.action.params.values || {};
  if (userId === undefined || departmentId === undefined) {
    ctx.throw(400, ctx.t('User and department are required', { ns: 'departments' }));
  }
  if (await canManageDepartment(ctx, departmentId)) {
    if (!(await canAccessOwnerUser(ctx, userId))) {
      ctx.throw(403);
    }
    const throughRepo = ctx.db.getRepository('departmentsUsers');
    await throughRepo.update({
      filter: {
        userId,
        departmentId,
      },
      values: {
        isOwner: false,
      },
    });
  }
  await next();
};
