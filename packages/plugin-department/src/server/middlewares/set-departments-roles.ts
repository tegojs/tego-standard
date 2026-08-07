import type { ArrayFieldRepository, Context, Next } from '@tego/server';

const departmentsInfoLoaded = Symbol('departmentsInfoLoaded');

export const loadDepartmentsInfo = async (ctx: Context) => {
  if (ctx.state[departmentsInfoLoaded]) {
    return;
  }
  ctx.state[departmentsInfoLoaded] = true;

  const currentUser = ctx.state.currentUser;
  if (!currentUser) {
    return;
  }
  const cache = ctx.cache;
  const repo = ctx.db.getRepository<ArrayFieldRepository>('users.departments', currentUser.id);
  const departments = await cache.wrap(`departments:${currentUser.id}`, () =>
    repo.find({
      // FIXME: 看下这个实际类型是啥？
      // @ts-expect-error
      appends: ['owners', 'roles', 'parent(recursively=true)'],
      raw: true,
    }),
  );
  if (!departments.length) {
    return;
  }
  ctx.state.currentUser.departments = departments;
  ctx.state.currentUser.mainDeparmtent = departments.find((dept) => dept.isMain);
  const departmentIds = departments.map((dept) => dept.id);
  const roleRepo = ctx.db.getRepository('roles');
  const roles = await roleRepo.find({
    filter: {
      'departments.id': {
        $in: departmentIds,
      },
    },
  });
  if (!roles.length) {
    return;
  }
  const rolesMap = new Map();
  roles.forEach((role) => rolesMap.set(role.name, role));
  ctx.state.attachRoles = Array.from(rolesMap.values());
};

export const setDepartmentsInfo = async (ctx: Context, next: Next) => {
  await loadDepartmentsInfo(ctx);
  await next();
};
