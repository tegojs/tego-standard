import type { Context, Next } from '@tego/server';

export const checkUserDepartmentAssociationScope = async (ctx: Context, next: Next) => {
  const { associatedName, resourceName, associatedIndex, actionName } = ctx.action.params;
  if (associatedName === 'users' && resourceName === 'departments' && ['add', 'remove'].includes(actionName)) {
    const permission = ctx.tego.acl.can({
      role: ctx.state.currentRole,
      resource: 'users.departments',
      action: actionName,
    });
    const aclParams = ctx.tego.acl.filterParams(ctx, 'users', permission?.params || {});
    const { filter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
    if (Object.keys(filter).length) {
      const user = await ctx.db.getRepository('users').findOne({ filterByTk: associatedIndex, filter });
      if (!user) {
        ctx.throw(403);
      }
    }
  }
  await next();
};

export const setMainDepartment = async (ctx: Context, next: Next) => {
  await next();
  const { associatedName, resourceName, associatedIndex, actionName, values } = ctx.action.params;
  if (associatedName === 'departments' && resourceName === 'members' && (values == null ? void 0 : values.length)) {
    const throughRepo = ctx.db.getRepository('departmentsUsers');
    const usersHasMain = await throughRepo.find({
      filter: {
        userId: {
          $in: values,
        },
        isMain: true,
      },
    });
    const userIdsHasMain = usersHasMain.map((item) => item.userId);
    if (actionName === 'add' || actionName === 'set') {
      await throughRepo.update({
        filter: {
          userId: {
            $in: values.filter((id) => !userIdsHasMain.includes(id)),
          },
          departmentId: associatedIndex,
        },
        values: {
          isMain: true,
        },
      });
      return;
    }
    if (actionName === 'remove') {
      const userIdsHasNoMain = values.filter((id) => !userIdsHasMain.includes(id));
      for (const userId of userIdsHasNoMain) {
        const firstDept = await throughRepo.findOne({
          filter: {
            userId,
          },
        });
        if (firstDept) {
          await throughRepo.update({
            filter: {
              userId,
              departmentId: firstDept.departmentId,
            },
            values: {
              isMain: true,
            },
          });
        }
      }
    }
  }
  if (associatedName === 'users' && resourceName === 'departments' && ['add', 'remove', 'set'].includes(actionName)) {
    const throughRepo = ctx.db.getRepository('departmentsUsers');
    const hasMain = await throughRepo.findOne({
      filter: {
        userId: associatedIndex,
        isMain: true,
      },
    });
    if (hasMain) {
      return;
    }
    const firstDept = await throughRepo.findOne({
      filter: {
        userId: associatedIndex,
      },
    });
    if (firstDept) {
      await throughRepo.update({
        filter: {
          userId: associatedIndex,
          departmentId: firstDept.departmentId,
        },
        values: {
          isMain: true,
        },
      });
    }
  }
};
