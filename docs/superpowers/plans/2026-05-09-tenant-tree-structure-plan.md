# 租户树状结构 — 实现计划

> 设计文档：`docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md`

## 变更清单

## 2026-06-12 复核状态

当前代码已完成租户树基础模型、`tenantInherited` 读过滤、当前租户子孙 ID 注入、path 创建与移动、循环检测、删除非叶子节点拒绝等主体能力。仍需注意以下未闭合或与计划不一致的点：

- `tenant-tree.ts` 已实现 `getDescendantIds/buildPath/canManageTenant/wouldCreateCycle`，但未实现计划中的 `getDescendantTenants(repo, tenantId)`。如后续没有调用需求，可在计划中取消；否则仍需补 helper。
- `available-tenants.ts` 当前扩展为“直接归属租户 + enabled 子孙租户”，不是本计划写的“包含用户归属租户的所有祖先”。需要结合产品决策更新代码或更新计划。
- `path` 字段已有 `maxLength: 500`，但计划中的“深度限制/友好拒绝”还没有 hook 层实现。
- collection-manager 动态路径已覆盖 `tenantScoped` 与 `tenantInherited` 自动补 `tenantId`；程序化 `defineCollection` 的自动补字段仍只看到 `tenantScoped` 路径。
- Phase 6 后台链路已有部分完成，但 workflow、异步导出、图表缓存和 legacy 旧数据读范围仍需按 `tenant-isolation-review-notes.md` 与实施规划继续处理。

### Phase 1：数据模型（tenants 集合）

**文件：`packages/module-tenant/src/server/collections/tenants.ts`**
- 添加 `parentId` 字段（string uid，nullable）
- 添加 `parent` 关系（belongsTo self）
- 添加 `children` 关系（hasMany self）
- 添加 `path` 字段（string，maxLength 500）

### Phase 2：服务端核心逻辑

**文件：`packages/module-tenant/src/server/helpers/tenant-filter.ts`**
- `applyTenantFilter` 支持 `tenantInherited` 模式
- 当 tenancy === 'tenantInherited' 时，使用 `$in` 过滤而非 `=`

**文件：`packages/module-tenant/src/server/helpers/isTenantScopedCollection.ts`**
- 导出辅助函数 `isTenantInheritedCollection(collection)`
- 或改为返回 `tenancy` 值而非布尔

**文件：`packages/module-tenant/src/server/middlewares/setCurrentTenant.ts`**
- 解析 currentTenant 后，查询子孙 ID 列表
- 写入 `ctx.state.currentTenantDescendantIds`

**文件：`packages/module-tenant/src/server/helpers/tenant-tree.ts`（新建）**
- `getDescendantIds(repo, tenantId)` — 查询子孙 ID
- `getDescendantTenants(repo, tenantId)` — 查询子孙完整记录
- `buildPath(parentPath, id)` — 拼接路径
- `canManageTenant(managerTenantId, targetTenant)` — 权限判断
- `wouldCreateCycle(repo, tenantId, newParentId)` — 循环检测

**文件：`packages/module-tenant/src/server/server.ts`**
- tenantResourceGuard 中间件支持 tenantInherited

**文件：`packages/module-tenant/src/server/actions/`（修改现有 + 新增）**
- `switch-tenant.ts` — 验证切换目标时考虑 path 关系
- `available-tenants.ts` — 扩展：包含用户归属租户的所有祖先
- 新增 `create-tenant.ts`（如有必要，或内联到 server.ts 的 collection hook）
- 新增 `move-tenant.ts`（或在 update 中处理 parentId 变更）

**文件：`packages/module-tenant/src/server/collections/tenants.ts` + server.ts hooks**
- beforeCreate hook：自动生成 path
- beforeUpdate hook：parentId 变更时重建子树 path
- beforeDestroy hook：有子节点时拒绝删除

### Phase 3：国际化

**文件：`packages/module-tenant/src/server/locale/en-US.ts` 和 `zh-CN.ts`**
- 添加树相关的新错误消息和标签

### Phase 4：测试

**文件：`packages/module-tenant/src/server/__tests__/tenant-tree.test.ts`（新建）**
- 创建子租户自动设置 path
- 子孙查询正确性
- 移动租户后 path 更新
- 循环引用拒绝
- 删除有子节点的租户被拒绝
- 深度限制

**文件：现有测试更新**
- `set-current-tenant.test.ts` — 添加树结构下的解析测试
- `tenant-filter.test.ts` — 添加 tenantInherited 模式测试
- `tenant-resource-guard.test.ts` — 添加继承模式下的 CRUD 隔离测试
- `tenant-export.test.ts` / `tenant-import.test.ts` — 确保继承模式下导入导出正确

### Phase 5：客户端（后续独立 PR 可选）

- `TenantManagement.tsx` — 将列表改为树形展示
- `useSwitchTenant.tsx` — 租户切换支持树形结构
- 此阶段暂不改客户端，仅做服务端改造

### Phase 6：后台链路租户上下文传播

> 详细执行计划：`docs/superpowers/plans/2026-05-25-tenant-isolation-next-work.md`

**文件：`packages/plugin-action-import/src/server/utils/transform.ts`**
- 导入关联字段解析的 `find/findOne` 传递当前导入请求 `context`
- 防止 A/B 租户同名关联记录跨租户匹配

**文件：`packages/module-tenant/src/server/__tests__/tenant-import.test.ts`**
- 增加导入关联查询租户隔离测试

**文件：`packages/module-workflow/src/server/collections/executions.ts`**
- execution 保存 `tenantId` 和最小可序列化 `tenantContext`

**文件：`packages/module-workflow/src/server/Plugin.ts`、`packages/module-workflow/src/server/Processor.ts`**
- trigger/createExecution/process/resume/retry 保存并恢复租户上下文
- workflow repository 操作复用恢复后的 context

**文件：`packages/module-workflow/src/server/triggers/DateFieldScheduleTrigger.ts`（或实际对应文件）**
- 日期字段定时触发避免无租户上下文全量扫描 tenant-enabled 集合

**文件：`packages/plugin-audit-logs/src/server/collections/auditLogs.ts` 与 hooks**
- 审计日志记录 `tenantId`、真实操作者、平台管理员代入目标租户和上下文来源

**文件：`packages/module-tenant/src/server/middlewares/setCurrentTenant.ts`**
- 平台管理员显式 `X-Tenant-Id` 代入租户时保留 actor user，不覆盖 `currentUser`
- 普通用户仍按 tenantUsers 与租户树访问关系校验

## 执行顺序

1. Phase 1 → Phase 2 → Phase 3 → Phase 4
2. 每个 Phase 完成后运行测试确认无回归
3. Phase 5 视需要后续进行
4. Phase 6 按独立提交推进：文档计划 → 导入关联查询 → workflow execution 上下文 → workflow 执行恢复 → 日期字段定时任务 → audit → 平台管理员代入
