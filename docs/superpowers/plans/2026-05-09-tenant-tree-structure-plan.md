# 租户树状结构 — 实现计划

> 设计文档：`docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md`

## 变更清单

## 2026-06-29 复核状态

当前代码已完成租户树基础模型、`tenantInherited` 读过滤、当前租户子孙 ID 注入、path 创建与移动、path 长度友好校验、循环检测、删除非叶子节点拒绝等主体能力。2026-06-29 继续复核了后台链路和 tenant 插件禁用边界，当前状态如下：

- `tenant-tree.ts` 已实现 `getDescendantIds/getDescendantTenants/buildPath/canManageTenant/wouldCreateCycle`。
- `available-tenants.ts` 当前实现为“直接归属租户 + enabled 子孙租户”，不包含祖先租户；当前测试也按“父可切子、子不可切父”断言。若产品后续要求“子可切父”，需要单独改代码和测试。
- collection-manager 动态路径已覆盖 `tenantScoped` 与 `tenantInherited` 自动补 `tenantId`；程序化 `defineCollection` 路径也已覆盖两者，并且仅在 tenant 插件启用时注入。
- Phase 6 后台链路主体已完成：导入关联查询、workflow execution 上下文、workflow 指令直连 repository 过滤、general-action、date-field schedule descendants、审计、异步导出 worker 和图表 tenantScope 缓存均已适配。
- 仍需跟踪的是测试闭环与上线项：`module-file` tenant 上传/路径测试、workflow date-field schedule 租户上下文测试仍有 skipped 用例；历史数据归类迁移工具、灰度开关、回滚工具和上线压测仍未完成。

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
- `available-tenants.ts` — 当前实现为直接归属租户加 enabled 子孙租户，不向上包含祖先租户
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
>
> 当前状态：主体代码已完成，以下列表保留为实现范围追溯；剩余工作集中在 skipped 测试恢复、上线验证和迁移/灰度/回滚工具。

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

**文件：`packages/plugin-action-export/src/server/actions/export-xlsx.ts`、`packages/plugin-action-export/src/server/index.ts`**
- 同步和异步导出保留完整 tenant context
- worker repository 查询重新应用 `tenantScoped/tenantInherited/legacyDataTenantIds` 过滤

**文件：`packages/plugin-block-charts/src/server/actions/query.ts`**
- 图表查询追加租户过滤
- 缓存 key 纳入完整 `tenantScope`

**文件：`packages/module-user/src/server/server.ts`**
- 程序化 `tenantScoped/tenantInherited` 集合自动补 `tenantId`
- tenant 插件未安装或禁用时不注入租户字段

## 执行顺序

1. Phase 1 → Phase 2 → Phase 3 → Phase 4
2. 每个 Phase 完成后运行测试确认无回归
3. Phase 5 视需要后续进行
4. Phase 6 主体已完成；后续按测试闭环、上线验证、迁移/灰度/回滚工具继续推进
