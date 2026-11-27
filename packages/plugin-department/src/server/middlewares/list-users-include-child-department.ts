import { Repository, type Context, type Next } from '@tego/server';

type DepartmentInfo = {
  id: number;
  parentId: number;
  isLeaf: boolean;
};

function getChildIds(ids: number[], departmentIds: Set<number>, departments: DepartmentInfo[]) {
  const children = departments.filter((department) => ids.includes(department.parentId));
  const noLeaf: number[] = [];
  children.forEach((child) => {
    departmentIds.add(child.id);
    if (!child.isLeaf) {
      noLeaf.push(child.id);
    }
  });
  if (noLeaf.length) {
    getChildIds(noLeaf, departmentIds, departments);
  }
}

async function getAllDepartmentIds(repo: Repository, parentId: number, filter: Record<string, any>): Promise<number[]> {
  const departments = (await repo.find({
    fields: ['id', 'parentId', 'isLeaf'],
    filter,
    raw: true,
  })) as DepartmentInfo[];
  if (!departments.some((department) => Number(department.id) === parentId)) {
    return [];
  }
  const departmentIds = new Set<number>([parentId]);
  getChildIds([parentId], departmentIds, departments);
  return [...departmentIds];
}

export const listUsersIncludeChildDepartment = async (ctx: Context, next: Next) => {
  const { filter, resourceName, actionName } = ctx.action.params;
  const repo = ctx.db.getRepository('departments');
  if (resourceName === 'users' && actionName === 'list') {
    if (filter?.showChildren !== undefined) {
      const showChildren = filter.showChildren;
      delete filter.showChildren;
      const departmentId = filter['departments.id'] || filter?.departments?.id;
      if (showChildren && departmentId) {
        const permission = ctx.tego.acl.can({
          role: ctx.state.currentRole,
          resource: 'departments',
          action: 'list',
        });
        if (!permission) {
          ctx.throw(403);
        }

        const aclParams = ctx.tego.acl.filterParams(ctx, 'departments', permission.params || {});
        const { filter: departmentFilter = {} } = await ctx.tego.acl.parseJsonTemplate(aclParams, ctx);
        const departmentIds = await getAllDepartmentIds(repo, Number(departmentId), departmentFilter);
        if (!departmentIds.length) {
          ctx.throw(403);
        }
        if (departmentIds.length > 1) {
          if (filter?.departments?.id) {
            delete filter.departments.id;
          }
          delete filter['departments.id'];
          if (!filter.departments) {
            filter.departments = {};
          }
          filter.departments.id = {
            $in: departmentIds,
          };
        }
      }
    }
    return next();
  }
  return next();
};
