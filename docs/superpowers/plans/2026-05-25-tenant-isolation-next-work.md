# 租户隔离后续补强实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐导入关联查询、工作流执行、审计日志和平台管理员代入的租户上下文隔离能力。

**架构：** 采用最小租户上下文传播方案：请求内继续使用 `ctx.state.currentTenant/currentTenantId/currentTenantDescendantIds`，后台链路只保存和恢复必要的可序列化租户上下文。2026-06-29 复核后，workflow 直连 repository 路径已通过本地 helper 显式追加租户过滤，不再依赖 resourcer 级 `tenantResourceGuard`。

**技术栈：** TypeScript、Tego/Tachybase server resources、module-tenant、plugin-action-import、module-workflow、plugin-audit-logs、Vitest/Jest 风格测试、pnpm。

---

## 当前执行状态

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 任务 1：更新规划文档 | 已完成 | 已提交 `docs(tenant): plan next isolation hardening`。 |
| 任务 2：导入关联查询传递租户上下文 | 已完成 | `o2o/o2m/m2o/m2m` 关联查询已传递导入请求 `context`，并新增跨租户同名关联记录测试。 |
| 任务 3：workflow execution 保存租户上下文 | 已完成 | execution 已保存 `tenantId` 与 `tenantContext`，包含 descendants、tenancy mode 和 legacy 可见配置。 |
| 任务 4：workflow 执行时恢复租户上下文 | 已完成 | query/select/update/updateorcreate/destroy/aggregate 已使用 `processor.getRepositoryContext()` 和本地租户 helper 强制过滤，并新增模块边界测试。 |
| 任务 5：日期字段定时 workflow 按租户上下文执行 | 代码完成，测试待恢复 | 日期字段定时触发已按记录构造并传递租户上下文，`tenantInherited` 会查询 descendants；对应 schedule 测试仍有 skipped 用例需恢复。 |
| 任务 6：审计日志记录租户与 actor context | 已完成 | audit log 字段、hooks、worker payload 保留与基础测试已完成。 |
| 任务 7：平台管理员代入租户并写入审计上下文 | 已完成 | 中间件显式代入、state 元数据和 audit log 集成测试已完成。 |

补充复核项：

- 异步导出 worker 已接收完整 `tenantContext`，并在 worker repository 查询前重新应用 `tenantScoped/tenantInherited/legacyDataTenantIds` 过滤。
- 图表查询已追加租户过滤，缓存 key 已包含完整 `tenantScope`（`tenancyMode`、descendants、`legacyDataTenantIds`）。
- `module-user` 程序化 `tenantScoped/tenantInherited` 自动补字段已加 tenant 插件启用状态门禁，tenant 插件不存在或禁用时不会注入 `tenantId`。
- `module-workflow` 已移除运行时 `@tachybase/module-tenant` 静态导入，tenant-aware 指令使用本地 helper；tenant 模块未启用且无租户上下文时 no-op。
- `available-tenants` 当前实现是直接归属租户加 enabled 子孙租户，不向上包含祖先租户；租户树设计文档已按当前实现决策更新。
- workflow executions、auditLogs、attachments 已有字段迁移；历史数据归类迁移工具、灰度开关和回滚工具仍未闭合，`legacyDataTenantIds` 只是读时兼容策略。
- `module-file` 上传/路径/附件隔离测试和 workflow date-field schedule 租户上下文测试仍有 skipped 用例，属于后续测试闭环风险。

> 以下任务章节保留为历史实施计划，便于追溯当时的拆分方式；当前状态以上方“当前执行状态”和“补充复核项”为准。

## 文件结构

- 修改：`租户隔离规划方案.md` — 记录导入 transform、workflow、audit/impersonation 的设计原则与验收标准。
- 修改：`租户隔离实施规划方案.md` — 更新当前状态、实施范围和测试验收矩阵。
- 修改：`docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md` — 将后台链路上下文传播纳入租户树设计。
- 修改：`docs/superpowers/plans/2026-05-09-tenant-tree-structure-plan.md` — 追加 Phase 6 后续计划入口。
- 创建：`docs/superpowers/plans/2026-05-25-tenant-isolation-next-work.md` — 当前执行计划。
- 修改：`packages/plugin-action-import/src/server/utils/transform.ts` — 导入关联字段解析传递请求 context。
- 修改：`packages/module-tenant/src/server/__tests__/tenant-import.test.ts` — 覆盖导入关联查询跨租户同名记录风险。
- 修改：`packages/module-workflow/src/server/collections/executions.ts` — execution 保存 `tenantId` 与 `tenantContext`。
- 修改：`packages/module-workflow/src/server/Plugin.ts` — trigger/createExecution/dispatch/process 保存并恢复租户上下文。
- 修改：`packages/module-workflow/src/server/Processor.ts` — 提供 workflow 指令可复用的 repository context。
- 修改：`packages/module-workflow/src/server/triggers/DateFieldScheduleTrigger.ts` 或实际日期字段定时触发文件 — 避免无租户上下文全量扫描。
- 修改：workflow 查询/写入指令文件 — repository 操作传递恢复后的 context。
- 修改：`packages/plugin-audit-logs/src/server/collections/auditLogs.ts` — 审计日志新增租户与代入字段。
- 修改：`packages/plugin-audit-logs/src/server/hooks/after-create.ts` — create 审计捕获租户与 actor context。
- 修改：`packages/plugin-audit-logs/src/server/hooks/after-update.ts` — update 审计捕获租户与 actor context。
- 修改：`packages/plugin-audit-logs/src/server/hooks/after-destroy.ts` — destroy 审计捕获租户与 actor context。
- 修改：`packages/plugin-audit-logs/src/server/index.ts` — worker payload/write shape 保留新增审计字段。
- 修改：`packages/module-tenant/src/server/middlewares/setCurrentTenant.ts` — 平台管理员显式代入租户时设置审计上下文元数据。

### 任务 1：更新规划文档

**文件：**
- 修改：`租户隔离规划方案.md`
- 修改：`租户隔离实施规划方案.md`
- 修改：`docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md`
- 修改：`docs/superpowers/plans/2026-05-09-tenant-tree-structure-plan.md`
- 创建：`docs/superpowers/plans/2026-05-25-tenant-isolation-next-work.md`

- [ ] **步骤 1：更新总体规划**

在 `租户隔离规划方案.md` 追加后台链路补强章节，包含导入 transform、workflow、audit/impersonation 的设计与验收标准。

- [ ] **步骤 2：更新实施规划状态**

在 `租户隔离实施规划方案.md` 将“导入 transform 关联查询租户上下文”列为未完成项，将高风险后台链路拆为导入关联查询、工作流、审计日志、平台管理员代入。

- [ ] **步骤 3：更新租户树设计与计划**

在 `docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md` 增加后台链路租户上下文传播设计。

在 `docs/superpowers/plans/2026-05-09-tenant-tree-structure-plan.md` 增加 Phase 6，并链接当前计划文件。

- [ ] **步骤 4：提交文档计划**

运行：

```bash
git add "租户隔离规划方案.md" "租户隔离实施规划方案.md" docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md docs/superpowers/plans/2026-05-09-tenant-tree-structure-plan.md docs/superpowers/plans/2026-05-25-tenant-isolation-next-work.md
git commit -m "docs(tenant): plan next isolation hardening"
```

预期：pre-commit hooks 通过并生成文档 commit。

### 任务 2：导入关联查询传递租户上下文

**文件：**
- 修改：`packages/module-tenant/src/server/__tests__/tenant-import.test.ts`
- 修改：`packages/plugin-action-import/src/server/utils/transform.ts`

- [ ] **步骤 1：编写失败的集成测试**

在 `tenant-import.test.ts` 增加测试：

```ts
it('should resolve imported relation values within the current tenant context', async () => {
  app = await createTenantApp({
    extraPlugins: [[ImportPlugin, { name: 'action-import', packageName: '@tachybase/plugin-action-import' }]],
  });

  await app.db.getRepository('tenants').create({
    values: [
      { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
      { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B' },
    ],
  });

  const user = await app.db.getRepository('users').create({
    values: {
      username: 'tenant_import_relation_user',
      email: 'tenant-import-relation-user@example.com',
      phone: '10000010013',
      password: '123456',
      roles: ['admin'],
      tenants: ['tenant-a', 'tenant-b'],
      defaultTenantId: 'tenant-a',
    },
  });

  await app.db.getRepository('roles').update({
    filterByTk: 'admin',
    values: { strategy: { actions: ['create', 'view', 'update', 'destroy', 'importXlsx'] } },
  });

  await app.db.getRepository('collections').create({
    values: {
      name: 'tenant_import_categories',
      tenancy: 'tenantScoped',
      fields: [{ type: 'string', name: 'name' }],
    },
    context: {},
  });

  await app.db.getRepository('collections').create({
    values: {
      name: 'tenant_import_articles',
      tenancy: 'tenantScoped',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'belongsTo', name: 'category', target: 'tenant_import_categories' },
      ],
    },
    context: {},
  });

  const categoryA = await app.db.getRepository('tenant_import_categories').create({
    values: { name: 'Shared Category', tenantId: 'tenant-a' },
  });
  await app.db.getRepository('tenant_import_categories').create({
    values: { name: 'Shared Category', tenantId: 'tenant-b' },
  });

  const workbook = xlsx.build([{ name: 'Sheet 1', data: [['Title', 'Category'], ['Imported A1', 'Shared Category']] }]);
  const filePath = path.join(process.env.TEGO_RUNTIME_HOME || process.cwd(), 'tenant-import-relation.xlsx');
  await writeFile(filePath, workbook);

  const response = await app
    .agent()
    .login(user)
    .post('/tenant_import_articles:importXlsx')
    .attach('file', filePath)
    .field(
      'columns',
      JSON.stringify([
        { dataIndex: ['title'], defaultTitle: 'Title' },
        { dataIndex: ['category', 'name'], defaultTitle: 'Category' },
      ]),
    )
    .finally(async () => {
      await unlink(filePath).catch(() => undefined);
    });

  expect(response.status).toBe(200);
  const article = await app.db.getRepository('tenant_import_articles').findOne({ appends: ['category'] });
  expect(article.get('categoryId')).toBe(categoryA.get('id'));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm test:server packages/module-tenant/src/server/__tests__/tenant-import.test.ts
```

预期：新增用例失败，原因是 transform 关联查询没有传递 `context`，或本地 fixture 初始化报已知 `SQLITE_ERROR: no such table: applicationPlugins`。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/plugin-action-import/src/server/utils/transform.ts` 中，把 relation lookup 改为传递 context：

```ts
const val = await repository.findOne({ filter: { [dataIndex[1]]: enumItem?.value ?? value }, context: ctx });
```

```ts
results = await repository.find({ filter: { [dataIndex[1]]: enumValues }, context: ctx });
```

```ts
results = await repository.find({ filter: { [dataIndex[1]]: values }, context: ctx });
```

```ts
results = await repository.findOne({ filter: { [dataIndex[1]]: enumValue }, context: ctx });
```

```ts
results = await repository.findOne({ filter: { [dataIndex[1]]: value }, context: ctx });
```

不要改变 `chinaRegion` 的共享字典查询，除非当前集合被证明启用了 tenancy。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm test:server packages/module-tenant/src/server/__tests__/tenant-import.test.ts
```

预期：导入关联查询测试通过，或记录本地 fixture 初始化阻塞的精确错误。

- [ ] **步骤 5：Commit**

```bash
git add packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/plugin-action-import/src/server/utils/transform.ts
git commit -m "fix(import): scope relation lookup by tenant context"
```

### 任务 3：workflow execution 保存租户上下文

**文件：**
- 修改：`packages/module-workflow/src/server/collections/executions.ts`
- 修改：`packages/module-workflow/src/server/Plugin.ts`
- 测试：`packages/module-workflow/src/server/__tests__/` 下现有 workflow 测试文件或新测试文件

- [ ] **步骤 1：编写失败测试**

新增或扩展 workflow 触发测试，断言从带 `ctx.state.currentTenantId = 'tenant-a'` 的请求触发 workflow 后，execution 保存：

```ts
expect(execution.get('tenantId')).toBe('tenant-a');
expect(execution.get('tenantContext')).toMatchObject({
  currentTenantId: 'tenant-a',
  currentTenantDescendantIds: expect.any(Array),
});
```

- [ ] **步骤 2：运行测试验证失败**

运行对应 workflow 测试文件：

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts
```

预期：字段不存在或值为空。

- [ ] **步骤 3：添加 execution 字段**

在 `executions.ts` fields 中加入：

```ts
{
  type: 'string',
  name: 'tenantId',
  index: true,
},
{
  type: 'json',
  name: 'tenantContext',
},
```

- [ ] **步骤 4：保存最小 tenant context**

在 `Plugin.ts` 中添加 helper，从 context/options 中提取：

```ts
function getTenantContext(context: any, options: any = {}) {
  const state = options.context?.state || context?.state || context?.context?.state;
  if (!state?.currentTenantId) {
    return null;
  }

  return {
    currentTenant: state.currentTenant,
    currentTenantId: state.currentTenantId,
    currentTenantDescendantIds: state.currentTenantDescendantIds || [],
  };
}
```

在 `createExecution` 的 `workflow.createExecution` values 中写入：

```ts
tenantId: tenantContext?.currentTenantId,
tenantContext,
```

- [ ] **步骤 5：运行测试验证通过**

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add packages/module-workflow/src/server/collections/executions.ts packages/module-workflow/src/server/Plugin.ts packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts
git commit -m "feat(workflow): persist tenant context on executions"
```

### 任务 4：workflow 执行时恢复租户上下文

**文件：**
- 修改：`packages/module-workflow/src/server/Plugin.ts`
- 修改：`packages/module-workflow/src/server/Processor.ts`
- 修改：workflow 查询/写入指令文件
- 测试：workflow 租户隔离测试

- [ ] **步骤 1：编写失败测试**

创建 A/B 租户同名业务记录，触发 tenant-a workflow，在异步 process 中执行 query/update/create 指令，断言只影响 tenant-a 可见记录。

核心断言：

```ts
expect(tenantARecord.get('status')).toBe('processed');
expect(tenantBRecord.get('status')).toBe('pending');
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts
```

预期：workflow repository 操作缺少租户 context，可能读写到错误租户或全量数据。

- [ ] **步骤 3：在 Processor 提供 repository context**

在 `Processor.ts` 增加方法：

```ts
getRepositoryContext() {
  const tenantContext = this.execution.get?.('tenantContext') || this.execution.tenantContext;
  return {
    state: {
      ...(this.options.context?.state || {}),
      ...tenantContext,
    },
  };
}
```

- [ ] **步骤 4：指令 repository 操作传递 context**

将 workflow 指令中的 repository 操作改为：

```ts
const context = processor.getRepositoryContext();
await repository.find({ filter, transaction: processor.transaction, context });
```

create/update/destroy/aggregate 同样传递 `context`。

- [ ] **步骤 5：确保 resume/retry 使用同一恢复逻辑**

检查 `Plugin.ts` 中 `process(execution, job, options)`、retry、resume 调用路径，确保构造 `Processor` 时不丢弃 execution 上的 `tenantContext`。

- [ ] **步骤 6：运行测试验证通过**

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts
```

- [ ] **步骤 7：Commit**

```bash
git add packages/module-workflow/src/server/Plugin.ts packages/module-workflow/src/server/Processor.ts packages/module-workflow/src/server/actions packages/module-workflow/src/server/instructions packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts
git commit -m "feat(workflow): restore tenant context during processing"
```

### 任务 5：日期字段定时 workflow 按租户上下文执行

**文件：**
- 修改：`packages/module-workflow/src/server/triggers/DateFieldScheduleTrigger.ts` 或实际日期字段定时触发文件
- 测试：日期字段 schedule workflow 测试

- [ ] **步骤 1：编写失败测试**

构造 tenant-enabled 集合在 A/B 租户各有一条满足日期条件的记录，运行日期字段定时触发逻辑，断言不会在无租户上下文下一次性处理两个租户的数据。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-schedule-test>.test.ts
```

预期：当前 raw `model.findAll` 或等价无 context 查询跨租户扫描。

- [ ] **步骤 3：改用 repository + context 或按租户分片**

如果触发器有明确 tenant context，使用：

```ts
await repository.find({ filter, context: tenantContext, transaction });
```

如果触发器是平台级调度，则先列出租户上下文，再按租户分别查询并创建 execution。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-schedule-test>.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add packages/module-workflow/src/server/triggers/DateFieldScheduleTrigger.ts packages/module-workflow/src/server/__tests__/<target-schedule-test>.test.ts
git commit -m "fix(workflow): scope date field schedules by tenant"
```

### 任务 6：审计日志记录租户与 actor context

**文件：**
- 修改：`packages/plugin-audit-logs/src/server/collections/auditLogs.ts`
- 修改：`packages/plugin-audit-logs/src/server/hooks/after-create.ts`
- 修改：`packages/plugin-audit-logs/src/server/hooks/after-update.ts`
- 修改：`packages/plugin-audit-logs/src/server/hooks/after-destroy.ts`
- 修改：`packages/plugin-audit-logs/src/server/index.ts`
- 测试：audit logs server tests

- [ ] **步骤 1：编写失败测试**

在审计测试中通过带 tenant context 的 repository create/update/destroy 触发审计，断言：

```ts
expect(log.get('tenantId')).toBe('tenant-a');
expect(log.get('actorUserId')).toBe(user.get('id'));
expect(log.get('isTenantImpersonation')).toBeFalsy();
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test:server packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
```

预期：auditLogs 无新增字段或字段为空。

- [ ] **步骤 3：添加 auditLogs 字段**

在 `auditLogs.ts` fields 中加入：

```ts
{ type: 'string', name: 'tenantId', index: true },
{ type: 'string', name: 'actorUserId', index: true },
{ type: 'string', name: 'impersonatedTenantId', index: true },
{ type: 'string', name: 'tenantContextSource' },
{ type: 'boolean', name: 'isTenantImpersonation' },
```

- [ ] **步骤 4：hooks 捕获 context**

在 after-create/update/destroy hooks 中从 `options.context.state` 提取：

```ts
const state = options?.context?.state;
const tenantId = state?.currentTenantId;
const actorUserId = state?.actorUserId || state?.currentUser?.id;
const impersonatedTenantId = state?.impersonatedTenantId;
const tenantContextSource = state?.tenantContextSource;
const isTenantImpersonation = !!state?.isTenantImpersonation;
```

将这些字段写入 audit payload。

- [ ] **步骤 5：worker 写入保留字段**

在 `index.ts` 的 audit worker 写入 `auditLogs` 时保留新增字段。

- [ ] **步骤 6：运行测试验证通过**

```bash
pnpm test:server packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
```

- [ ] **步骤 7：Commit**

```bash
git add packages/plugin-audit-logs/src/server/collections/auditLogs.ts packages/plugin-audit-logs/src/server/hooks/after-create.ts packages/plugin-audit-logs/src/server/hooks/after-update.ts packages/plugin-audit-logs/src/server/hooks/after-destroy.ts packages/plugin-audit-logs/src/server/index.ts packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
git commit -m "feat(audit): record tenant and actor context"
```

### 任务 7：平台管理员代入租户并写入审计上下文

**文件：**
- 修改：`packages/module-tenant/src/server/middlewares/setCurrentTenant.ts`
- 修改：`packages/module-tenant/src/server/actions/switch-tenant.ts`（如需要）
- 测试：tenant middleware/audit integration tests

- [ ] **步骤 1：编写失败测试**

测试 root/platform admin 显式发送 `X-Tenant-Id: tenant-b`，即使不在 tenantUsers 中也能进入启用的 tenant-b，但上下文保留真实用户：

```ts
expect(response.status).toBe(200);
expect(response.body.data.id).toBe('tenant-b');
expect(auditLog.get('actorUserId')).toBe(rootUser.get('id'));
expect(auditLog.get('impersonatedTenantId')).toBe('tenant-b');
expect(auditLog.get('isTenantImpersonation')).toBe(true);
```

同时测试普通用户发送无权 `X-Tenant-Id` 仍返回 403。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test:server packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
```

预期：平台管理员无法代入或审计字段缺失。

- [ ] **步骤 3：实现平台管理员显式代入**

在 `setCurrentTenant.ts` 中：

```ts
const isPlatformImpersonation = requestedTenantId && ctx.state.currentRole === 'root' && !allowedTenantIds.includes(requestedTenantId);
```

对 root/platform admin 允许显式选择启用租户；普通用户继续使用 allowed tenant 校验。

- [ ] **步骤 4：设置审计上下文元数据**

```ts
ctx.state.actorUserId = ctx.state.currentUser.id;
ctx.state.tenantContextSource = isPlatformImpersonation ? 'platformImpersonation' : 'membership';
ctx.state.impersonatedTenantId = isPlatformImpersonation ? currentTenantId : null;
ctx.state.isTenantImpersonation = !!isPlatformImpersonation;
```

不修改 `ctx.state.currentUser`。

- [ ] **步骤 5：运行测试验证通过**

```bash
pnpm test:server packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
```

- [ ] **步骤 6：Commit**

```bash
git add packages/module-tenant/src/server/middlewares/setCurrentTenant.ts packages/module-tenant/src/server/actions/switch-tenant.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
git commit -m "feat(tenant): support platform tenant impersonation audit context"
```

## 最终验证

- [ ] **运行 tenant 相关回归**

```bash
pnpm test:server packages/module-tenant/src/server/__tests__/tenant-filter.test.ts packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts
```

- [ ] **运行 workflow 相关回归**

```bash
pnpm test:server packages/module-workflow/src/server/__tests__/<target-workflow-test>.test.ts packages/module-workflow/src/server/__tests__/<target-schedule-test>.test.ts
```

- [ ] **运行 audit 相关回归**

```bash
pnpm test:server packages/plugin-audit-logs/src/server/__tests__/<target-audit-test>.test.ts
```

- [ ] **检查 git 状态**

```bash
git status --short
```

预期：所有计划内改动已提交，无意外未跟踪文件。
