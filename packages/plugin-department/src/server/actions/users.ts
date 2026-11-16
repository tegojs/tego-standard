import { DEFAULT_PAGE, DEFAULT_PER_PAGE, type Context, type Next } from '@tego/server';

export const listExcludeDept = async (ctx: Context, next: Next) => {
  const { departmentId, page = DEFAULT_PAGE, pageSize = DEFAULT_PER_PAGE } = ctx.action.params;
  const permission = ctx.can({ resource: 'users', action: 'list' });
  if (!permission) {
    ctx.body = { count: 0, rows: [], page: Number(page), pageSize: Number(pageSize), totalPage: 0 };
    await next();
    return;
  }
  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission.params || {});
  const { filter: listFilter = {}, fields } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  const repo = ctx.db.getRepository('users');
  const members = await repo.find({
    fields: ['id'],
    filter: {
      'departments.id': departmentId,
    },
  });
  const memberIds = members.map((member) => member.id);
  if (memberIds.length) {
    ctx.action.mergeParams({
      filter: {
        id: {
          $notIn: memberIds,
        },
      },
    });
  }
  const { filter } = ctx.action.params;
  const [rows, count] = await repo.findAndCount({
    context: ctx,
    offset: (page - 1) * pageSize,
    limit: pageSize,
    filter: {
      $and: [listFilter, filter || {}],
    },
    fields,
  });
  ctx.body = {
    count,
    rows,
    page: Number(page),
    pageSize: Number(pageSize),
    totalPage: Math.ceil(count / pageSize),
  };
  await next();
};
export const setDepartments = async (ctx: Context, next: Next) => {
  const { values = {} } = ctx.action.params;
  const { userId, departments = [] } = values;
  const repo = ctx.db.getRepository('users');
  const throughRepo = ctx.db.getRepository('departmentsUsers');
  const user = await repo.findOne({ filterByTk: userId });
  if (!user) {
    ctx.throw(400, ctx.t('User does not exist'));
  }
  const departmentIds = departments.map((department) => department.id);
  const main = departments.find((department) => department.isMain);
  const owners = departments.filter((department) => department.isOwner);
  await ctx.db.sequelize.transaction(async (t) => {
    await user.setDepartments(departmentIds, {
      through: {
        isMain: false,
        isOwner: false,
      },
      transaction: t,
    });
    if (main) {
      await throughRepo.update({
        filter: {
          userId,
          departmentId: main.id,
        },
        values: {
          isMain: true,
        },
        transaction: t,
      });
    }
    if (owners.length) {
      await throughRepo.update({
        filter: {
          userId,
          departmentId: {
            $in: owners.map((owner) => owner.id),
          },
        },
        values: {
          isOwner: true,
        },
        transaction: t,
      });
    }
  });
  await next();
};
export const setMainDepartment = async (ctx: Context, next: Next) => {
  const { userId, departmentId } = ctx.action.params.values || {};
  const permission = ctx.can({ resource: 'users', action: 'setMainDepartment' });
  const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission?.params || {});
  const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
  const user = await ctx.db.getRepository('users').findOne({ filterByTk: userId, filter });
  if (!user) {
    await next();
    return;
  }

  const throughRepo = ctx.db.getRepository('departmentsUsers');
  await ctx.db.sequelize.transaction(async (t) => {
    await throughRepo.update({
      filter: {
        userId,
        isMain: true,
      },
      values: {
        isMain: false,
      },
      transaction: t,
    });
    await throughRepo.update({
      filter: {
        userId,
        departmentId,
      },
      values: {
        isMain: true,
      },
      transaction: t,
    });
  });
  await next();
};
