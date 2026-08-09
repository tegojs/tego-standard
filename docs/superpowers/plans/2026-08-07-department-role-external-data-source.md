# 外部数据源部门角色解析实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让仅通过部门获得角色的用户可以用该角色访问已授权的外部数据源，同时保持主数据源和现有角色选择行为不变。

**架构：** `setCurrentRole` 在合并角色前触发 `acl:beforeSetCurrentRole` 异步事件。
部门插件复用请求级幂等的部门信息加载函数订阅该事件，同时保留主数据源原有
`setDepartmentsInfo` 中间件及标签顺序。

**技术栈：** TypeScript、Tego Application `AsyncEmitter`、Koa middleware、Vitest、
SQLite 测试数据库、pnpm 10、Node.js 22。

---

## 文件职责

- 修改 `packages/module-acl/src/server/middlewares/setCurrentRole.ts`：定义角色扩展事件的调用时机。
- 修改 `packages/plugin-department/src/server/middlewares/set-departments-roles.ts`：
  拆分可复用加载函数，并保证同一请求只加载一次。
- 修改 `packages/plugin-department/src/server/plugin.ts`：注册部门角色扩展监听器，保留原中间件注册。
- 修改 `packages/module-acl/src/server/__tests__/setCurrentRole.test.ts`：验证扩展角色先于当前角色选择完成。
- 创建 `packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts`：
  验证部门加载的请求级幂等及中间件续传。
- 修改 `packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts`：
  覆盖主数据源和外部数据源的部门角色行为，以及真正无角色错误。

## 环境约束

- 在为本任务创建的隔离 worktree 中执行。
- 使用 Node.js 22 和 pnpm 10，并确保对应的 Node.js 可执行文件位于 `PATH` 首位。
- 测试框架动态加载 workspace 插件的 `dist/server/index.js`；运行集成测试前必须重建已修改的 ACL 和部门包。
- `dist/` 是忽略文件，只用于本地测试，不纳入提交。

### 任务 1：建立角色扩展与部门加载红灯测试

**文件：**

- 修改：`packages/module-acl/src/server/__tests__/setCurrentRole.test.ts`
- 创建：`packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts`
- 修改：`packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts`

- [ ] **步骤 1：给 ACL 单元测试补充真实应用上下文**

在 `beforeEach` 创建的 `ctx` 中加入 `tego: api`，使测试上下文与运行时上下文一致：

```typescript
ctx = {
  tego: api,
  db,
  cache: api.cache,
  state: {
    currentRole: '',
  },
  t: (key) => key,
};
```

- [ ] **步骤 2：编写 ACL 扩展角色红灯测试**

在 `setCurrentRole.test.ts` 中新增测试。监听器异步写入 `attachRoles`，指定角色必须在监听器完成后被选中：

```typescript
it('should wait for roles attached by ACL extensions', async () => {
  ctx.state.currentUser = await createUser(['admin']);
  ctx.get = (name) => (name === 'X-Role' ? 'department-role' : undefined);

  const listener = vi.fn(async (eventCtx) => {
    await Promise.resolve();
    eventCtx.state.attachRoles = [{ name: 'department-role' }];
  });
  api.on('acl:beforeSetCurrentRole', listener);

  try {
    await setCurrentRole(ctx, () => {});
  } finally {
    api.off('acl:beforeSetCurrentRole', listener);
  }

  expect(listener).toHaveBeenCalledWith(ctx);
  expect(ctx.state.currentRole).toBe('department-role');
});
```

- [ ] **步骤 3：编写部门加载幂等红灯测试**

创建 `set-departments-roles.test.ts`，使用真实 `setDepartmentsInfo` 和最小仓储替身：

```typescript
import { vi } from 'vitest';

import { setDepartmentsInfo } from '../middlewares/set-departments-roles';

describe('setDepartmentsInfo', () => {
  it('loads department roles once per request and continues each middleware call', async () => {
    const findDepartments = vi.fn().mockResolvedValue([{ id: 101, isMain: true }]);
    const findRoles = vi.fn().mockResolvedValue([{ name: 'developer' }]);
    const next = vi.fn();
    const ctx = {
      state: { currentUser: { id: 202 } },
      cache: {
        wrap: vi.fn((_key, loader) => loader()),
      },
      db: {
        getRepository: vi.fn((name) => {
          if (name === 'users.departments') {
            return { find: findDepartments };
          }
          if (name === 'roles') {
            return { find: findRoles };
          }
          throw new Error(`Unexpected repository: ${name}`);
        }),
      },
    } as any;

    await setDepartmentsInfo(ctx, next);
    await setDepartmentsInfo(ctx, next);

    expect(findDepartments).toHaveBeenCalledTimes(1);
    expect(findRoles).toHaveBeenCalledTimes(1);
    expect(ctx.state.currentUser.departments).toEqual([{ id: 101, isMain: true }]);
    expect(ctx.state.attachRoles).toEqual([{ name: 'developer' }]);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **步骤 4：为数据源集成测试启用部门插件并添加数据工厂**

把 `department` 加入 `dataSourceAclTestPlugins`，并在测试文件中新增：

```typescript
const createDepartmentRoleUser = async (suffix: string) => {
  const roleName = `department-role-${suffix}`;
  await app.db.getRepository('roles').create({
    values: { name: roleName, title: `Department role ${suffix}` },
  });
  const user = await app.db.getRepository('users').create({ values: { roles: [] } });
  await app.db.getRepository('rolesUsers').destroy({
    filter: { userId: user.id },
  });
  const directRoles = await app.db.getRepository('users.roles', user.id).find();
  expect(directRoles).toHaveLength(0);
  const department = await app.db.getRepository('departments').create({
    values: { title: `Department ${suffix}` },
  });
  await app.db.getRepository('departmentsUsers').create({
    values: { departmentId: department.id, userId: user.id, isMain: true },
  });
  await app.db.getRepository('departmentsRoles').create({
    values: { departmentId: department.id, roleName },
  });
  return { roleName, user };
};
```

- [ ] **步骤 5：编写主数据源部门角色回归测试**

```typescript
it('should use a department role on the main data source', async () => {
  const { roleName, user } = await createDepartmentRoleUser('main');

  const response = await app
    .agent()
    .login(user)
    .set('X-Role', roleName)
    .resource('roles')
    .check({});

  expect(response.status).toBe(200);
});
```

- [ ] **步骤 6：编写外部数据源部门角色红灯测试**

```typescript
it('should use a department role on an external data source', async () => {
  const { roleName, user } = await createDepartmentRoleUser('external');
  const adminUser = await app.db.getRepository('users').create({ values: { roles: ['root'] } });
  const adminAgent: any = app.agent().login(adminUser);
  const updateResponse = await adminAgent.resource('dataSources.roles', 'mockInstance1').update({
    filterByTk: roleName,
    values: { strategy: { actions: ['view'] } },
  });
  expect(updateResponse.status).toBe(200);

  const response = await getDataSourceAgent(app.agent().login(user), 'mockInstance1')
    .set('X-Role', roleName)
    .resource('api/posts')
    .list({});

  expect(response.status).toBe(200);
});
```

- [ ] **步骤 7：编写真正无角色用户的外部数据源回归测试**

```typescript
it(
  'should reject a user without direct or attached roles on an external data source',
  async () => {
    const user = await app.db.getRepository('users').create({ values: { roles: [] } });
    await app.db.getRepository('rolesUsers').destroy({
      filter: { userId: user.id },
    });

    const response = await getDataSourceAgent(app.agent().login(user), 'mockInstance1')
      .resource('api/posts')
      .list({});

    expect(response.status).toBe(401);
    expect(response.body.errors[0].code).toBe('USER_HAS_NO_ROLES_ERR');
  },
);
```

- [ ] **步骤 8：构建未修改的部门包并验证红灯原因**

运行：

```powershell
pnpm exec tegod build @tachybase/plugin-department --no-dts --development
pnpm test:server packages/module-acl/src/server/__tests__/setCurrentRole.test.ts
pnpm test:server packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts
pnpm test:server packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts
```

预期：

- ACL 新测试失败，因为 `acl:beforeSetCurrentRole` 监听器没有被调用。
- 部门幂等测试失败，因为部门和角色仓储各被调用 2 次。
- 外部数据源部门角色测试返回 HTTP 401，错误码为 `USER_HAS_NO_ROLES_ERR`。
- 主数据源部门角色和真正无角色测试通过。

- [ ] **步骤 9：提交红灯测试**

```powershell
git add `
  packages/module-acl/src/server/__tests__/setCurrentRole.test.ts `
  packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts `
  packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts
git commit -m "test: cover department roles on external data sources"
```

### 任务 2：添加 ACL 异步角色扩展点

**文件：**

- 修改：`packages/module-acl/src/server/middlewares/setCurrentRole.ts`

- [ ] **步骤 1：在读取附加角色前等待扩展监听器**

在登录用户检查之后加入：

```typescript
await ctx.tego.emitAsync('acl:beforeSetCurrentRole', ctx);

const attachRoles = ctx.state.attachRoles || [];
```

匿名角色和未登录请求继续在事件前返回。

- [ ] **步骤 2：运行 ACL 测试验证扩展点变绿**

运行：

```powershell
pnpm test:server packages/module-acl/src/server/__tests__/setCurrentRole.test.ts
```

预期：10 个测试全部通过。

- [ ] **步骤 3：提交 ACL 扩展点**

```powershell
git add packages/module-acl/src/server/middlewares/setCurrentRole.ts
git commit -m "feat(acl): add role resolution extension hook"
```

### 任务 3：让部门角色加载订阅 ACL 扩展点

**文件：**

- 修改：`packages/plugin-department/src/server/middlewares/set-departments-roles.ts`
- 修改：`packages/plugin-department/src/server/plugin.ts`

- [ ] **步骤 1：提取请求级幂等的部门加载函数**

把查询逻辑移动到 `loadDepartmentsInfo`，并用模块内部 `Symbol` 标记当前请求：

```typescript
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
```

查询字段、缓存键、角色去重顺序和 `mainDeparmtent` 现有属性名均保持不变。

- [ ] **步骤 2：注册部门角色扩展监听器**

在部门插件的 `load()` 中保留 `this.app.resourcer.use(setDepartmentsInfo, ...)`，并紧接着加入：

```typescript
this.app.on('acl:beforeSetCurrentRole', loadDepartmentsInfo);
```

同步更新 middleware import，导入 `loadDepartmentsInfo`。

- [ ] **步骤 3：运行部门幂等测试**

运行：

```powershell
pnpm test:server packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts
```

预期：测试通过；中间件调用 2 次，但部门和角色查询各执行 1 次。

- [ ] **步骤 4：重建运行时包并运行集成测试**

运行：

```powershell
pnpm exec tegod build @tachybase/module-acl @tachybase/plugin-department --no-dts --development
pnpm test:server packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts
```

预期：数据源测试全部通过；部门角色的主数据源和外部数据源请求均返回 HTTP 200，无角色请求仍返回 HTTP 401。

- [ ] **步骤 5：提交部门插件实现**

```powershell
git add `
  packages/plugin-department/src/server/middlewares/set-departments-roles.ts `
  packages/plugin-department/src/server/plugin.ts
git commit -m "fix(department): resolve roles for external data sources"
```

### 任务 4：回归验证与收尾

**文件：**

- 验证：本计划涉及的所有代码和测试文件

- [ ] **步骤 1：格式化变更文件**

运行：

```powershell
pnpm exec prettier --write `
  packages/module-acl/src/server/middlewares/setCurrentRole.ts `
  packages/module-acl/src/server/__tests__/setCurrentRole.test.ts `
  packages/plugin-department/src/server/middlewares/set-departments-roles.ts `
  packages/plugin-department/src/server/plugin.ts `
  packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts `
  packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts
```

- [ ] **步骤 2：运行定向测试**

运行：

```powershell
pnpm test:server `
  packages/module-acl/src/server/__tests__/setCurrentRole.test.ts `
  packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts `
  packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts
```

预期：所有测试通过，无失败或跳过。

- [ ] **步骤 3：运行相关包服务端测试**

运行：

```powershell
pnpm test:server `
  packages/module-acl/src/server/__tests__ `
  packages/plugin-department/src/server/__tests__ `
  packages/module-data-source/src/server/__tests__
```

预期：所有相关测试通过。若仓库基线存在与本变更无关的失败，记录具体测试、错误和与本分支的关系。

- [ ] **步骤 4：执行静态检查和差异检查**

运行：

```powershell
pnpm exec oxlint `
  packages/module-acl/src/server/middlewares/setCurrentRole.ts `
  packages/module-acl/src/server/__tests__/setCurrentRole.test.ts `
  packages/plugin-department/src/server/middlewares/set-departments-roles.ts `
  packages/plugin-department/src/server/plugin.ts `
  packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts `
  packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts
git diff --check main...HEAD
git status --short
```

预期：静态检查和差异检查退出码为 0；工作区只包含计划内变更。

- [ ] **步骤 5：验证回归测试确实能捕获原缺陷**

临时反向验证：在工作区中撤销 `setCurrentRole` 的事件调用但不提交，运行外部数据源
部门角色测试，确认它重新以 HTTP 401 和 `USER_HAS_NO_ROLES_ERR` 失败；随后恢复工作区实现
并重新运行，确认通过。

- [ ] **步骤 6：请求代码审查并处理反馈**

以 `main` 为基线审查完整差异，重点检查事件生命周期、请求级幂等、主数据源中间件顺序和测试真实性。修复所有 Critical 和 Important 问题后重新运行步骤 2 至步骤 4。

- [ ] **步骤 7：提交格式化或审查修正**

仅在步骤 1 或步骤 6 产生额外变更时运行：

```powershell
git add packages/module-acl packages/plugin-department packages/module-data-source
git commit -m "test: finalize department role regression coverage"
```

- [ ] **步骤 8：保留功能分支和 worktree**

保持功能分支和隔离 worktree，不合并、不推送，等待用户决定后续集成方式。
