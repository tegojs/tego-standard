import type { ArrayFieldRepository, Context, Next } from '@tego/server';

const DEPARTMENTS_INFO_LOADED = Symbol('departmentsInfoLoaded');

/**
 * Loads the current user's departments and merges their roles into `ctx.state.attachRoles`.
 *
 * A request-scoped marker prevents duplicate database queries when resource middleware and ACL
 * role resolution invoke this function for the same request.
 *
 * @param ctx - Request context to enrich with department and role data.
 */
export const loadDepartmentsInfo = async (ctx: Context) => {
  const state = ctx.state as {
    [DEPARTMENTS_INFO_LOADED]?: boolean;
  };
  if (state[DEPARTMENTS_INFO_LOADED]) {
    return;
  }
  state[DEPARTMENTS_INFO_LOADED] = true;

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
  (ctx.state.attachRoles || []).forEach((role) => rolesMap.set(role.name, role));
  roles.forEach((role) => rolesMap.set(role.name, role));
  ctx.state.attachRoles = Array.from(rolesMap.values());
};

/**
 * Loads department roles and continues the resource middleware chain.
 *
 * @param ctx - Request context to enrich with department and role data.
 * @param next - Middleware callback invoked after department data is loaded.
 */
export const setDepartmentsInfo = async (ctx: Context, next: Next) => {
  await loadDepartmentsInfo(ctx);
  await next();
};
