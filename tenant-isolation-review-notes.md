# Tenant isolation review notes

临时文档，用于记录 `feat/platform-tenant-isolation` 相比 `origin/main` 的系统性 review 结果，方便后续逐条修复核对。

约束：

- 只 review 隔离 worktree：`C:\Users\TomyJan\.config\superpowers\worktrees\tego-standard\feat-platform-tenant-isolation`
- 不切换主工作区分支
- 不触碰 sibling `tego` 项目
- 按用户要求不运行测试

本轮修复范围：

- 优先处理租户模块自身问题。
- 工作流、导出、图表、审计、文件等非当前租户模块适配暂缓处理，保留在本文档中供后续逐项核对。
- 测试基础设施、文档、catalog、AI 指南等范围污染问题暂缓处理，避免和测试开发分支目标混淆。

## 已确认问题

### 1. [暂缓处理] Workflow instructions 直接调用 repository，可能绕过租户过滤

涉及位置：

- `packages/module-workflow/src/server/instructions/QueryInstruction.ts:37`
- `packages/module-workflow/src/server/instructions/UpdateInstruction.ts:186`
- `packages/module-workflow/src/server/instructions/DestroyInstruction.ts:18`
- `packages/module-workflow/src/server/features/aggregate/AggregateInstruction.ts:30`

说明：当前租户过滤主要通过 resourcer middleware 调用 `applyTenantFilter(ctx)` 注入，而这些 workflow instruction 直接调用 repository。传入 `context: processor.getRepositoryContext()` 能传递上下文值，但不会自动把 `tenantId` / `tenantInherited` / legacy 可见租户条件追加到查询、更新、删除或聚合条件里。

风险：workflow 查询、更新、删除、聚合租户隔离集合时可能跨租户读写。

### 2. [暂缓处理] general-action 异步触发 workflow 时丢失租户上下文

涉及位置：

- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:140`
- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:274`

说明：同步路径会传 `{ httpContext: ctx }`，异步路径直接调用 `this.workflow.trigger(event[0], event[1])`，没有传递 httpContext 或等价 tenant context。`Plugin.extractTenantContext()` 因此无法持久化当前租户信息。

风险：异步 workflow 后续节点可能以空租户上下文运行。

### 3. [本轮修复] 租户树节点移动到根节点时不会重算 path

涉及位置：

- `packages/module-tenant/src/server/server.ts:153`
- `packages/module-tenant/src/server/__tests__/tenant-tree.test.ts`

说明：`tenants.beforeUpdate` 只在 `newParentId` 有值时重算 path。把节点移动到根节点时 `parentId` 为空，当前节点和子树 path 不会更新。

风险：`tenantInherited` 依赖 path 判断后代租户，路径错误会导致数据可见范围错误。

修复状态：已补充移动子树到根节点的测试，并调整 `tenants.beforeUpdate` 在 `parentId: null` 时也重算当前节点和子树 path。

### 3.1. [本轮修复] 租户树更新父节点时未校验禁用父租户

涉及位置：

- `packages/module-tenant/src/server/server.ts`
- `packages/module-tenant/src/server/__tests__/tenant-tree.test.ts`

说明：创建租户时会拒绝挂到禁用父租户，但更新 `parentId` 时只校验存在性和环路，没有校验父租户是否启用。

风险：租户树可能被移动到禁用父节点下，导致可访问租户、默认租户解析和树路径语义不一致。

修复状态：已补充移动到禁用父租户的测试，并在 `tenants.beforeUpdate` 中复用禁用父租户校验。

### 4. [暂缓处理] 新增租户字段 / 租户化已有表缺少迁移

涉及位置：

- `packages/module-workflow/src/server/collections/executions.ts:29`
- `packages/module-workflow/src/server/collections/executions.ts:34`
- `packages/plugin-audit-logs/src/server/collections/auditLogs.ts:32`
- `packages/plugin-audit-logs/src/server/collections/auditLogs.ts:37`
- `packages/plugin-audit-logs/src/server/collections/auditLogs.ts:42`
- `packages/plugin-audit-logs/src/server/collections/auditLogs.ts:47`
- `packages/plugin-audit-logs/src/server/collections/auditLogs.ts:51`
- `packages/module-file/src/server/collections/attachments.ts:7`

说明：branch 给 workflow executions、audit logs、attachments 引入租户字段或租户化，但对应 migrations 目录没有看到匹配迁移。

风险：升级环境已有表缺列，运行时读写失败；attachments 租户化后旧文件记录没有 `tenantId`，还会影响旧数据可见策略。

### 5. [暂缓处理] 程序化定义的 `tenantInherited` collection 可能不会自动补 `tenantId`

涉及位置：

- `packages/module-user/src/server/server.ts:90`

说明：collection-manager 动态路径的 `ensureTenantIdField` 覆盖了 `tenantScoped` 和 `tenantInherited`，但 `afterDefineCollection` 当前只判断 `tenantScoped`。

风险：代码里直接定义 `tenantInherited` 集合时，可能没有 `tenantId` 字段支撑继承过滤。

### 6. [暂缓处理] Charts 缓存 key 没有包含最终租户作用域

涉及位置：

- `packages/plugin-block-charts/src/server/actions/query.ts:486`

说明：`cacheMiddleware` 在 `applyTenantScope` 前执行，缓存 key 基于原始 filter 和 tenant/user 信息，但没有包含最终展开后的 descendants 或 legacy 可见租户集合。

风险：租户树或 legacy 可见配置变化后，图表查询可能命中旧范围缓存。

### 7. [暂缓处理] 大数据量导出走 worker 后只传 currentTenantId，未传最终租户过滤范围

涉及位置：

- `packages/plugin-action-export/src/server/actions/export-xlsx.ts:52`
- `packages/plugin-action-export/src/server/index.ts:45`
- `packages/plugin-action-export/src/server/index.ts:62`

说明：普通导出请求进入 resourcer 后，`tenantResourceGuard` 会把租户 filter 合并到 `ctx.action.params.filter`，所以当前进程内的 `count/find` 能用已经改写过的 filter。大数据量导出切到 worker 后，只额外传了 `currentTenantId`，worker 里构造的 `tenantContext` 也只有 `currentTenant/currentTenantId`，没有 `currentTenancyMode`、`currentTenantDescendantIds`、`currentLegacyDataTenantIds`，并且 worker 直接 `repository.find`，不会再经过 resourcer middleware。

风险：`tenantInherited` 导出在 worker 路径下无法正确包含子租户；legacy 旧数据可见配置也不会生效。若后续依赖 worker 里的 `context` 自动隔离，会出现和普通导出不一致的结果。

建议：传递已经合并后的 filter，或在 worker 内按 collection tenancy 重新计算完整租户 filter；同时覆盖 `tenantScoped`、`tenantInherited`、legacy 可见旧数据三类用例。

### 8. [暂缓处理] Workflow 持久化的 tenantContext 缺少 legacy 可见租户配置

涉及位置：

- `packages/module-workflow/src/server/Plugin.ts:60`
- `packages/module-workflow/src/server/Plugin.ts:70`
- `packages/module-workflow/src/server/Processor.ts:217`
- `packages/module-workflow/src/server/Processor.ts:222`

说明：`extractTenantContext()` 会保存 `currentTenant/currentTenantId/currentTenantDescendantIds/currentTenancyMode`，但没有保存 `currentLegacyDataTenantIds`。异步 workflow 后续由 `Processor.getRepositoryContext()` 恢复上下文后，即使目标 collection 配置了 legacy 旧数据对当前租户可见，workflow instruction 也无法知道这组租户配置。

风险：异步 workflow 查询、选择、更新或聚合租户隔离 collection 时，legacy 旧数据的可见性和普通 HTTP 请求不一致。

建议：执行记录中保存 legacy 可见租户信息，或在每个 instruction 执行前基于目标 collection 重新计算租户过滤条件。

### 9. [暂缓处理] Date-field schedule trigger 对 `tenantInherited` 的后代租户上下文固定为空

涉及位置：

- `packages/module-workflow/src/server/triggers/ScheduleTrigger/DateFieldScheduleTrigger.ts:92`
- `packages/module-workflow/src/server/triggers/ScheduleTrigger/DateFieldScheduleTrigger.ts:107`
- `packages/module-workflow/src/server/triggers/ScheduleTrigger/DateFieldScheduleTrigger.ts:406`

说明：`buildTenantContext()` 给 schedule workflow 构造上下文时，`currentTenantDescendantIds` 固定为 `[]`。如果触发记录属于 `tenantInherited` collection，后续 workflow instruction 恢复上下文后只能看到当前 tenant，不能看到其后代租户。

风险：定时字段触发的 workflow 在 `tenantInherited` 场景下读不到后代租户数据；如果修复了 instruction 租户过滤后，这里会成为新的漏范围点。

建议：按触发 tenant 查询 descendants，或把统一的 tenant context 构造逻辑从 `setCurrentTenant` 抽成可复用 helper。

### 10. [暂缓处理] CustomActionTrigger 加载触发数据时未带 context，可能跨租户组装 payload

涉及位置：

- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:93`
- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:95`
- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:102`
- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:239`
- `packages/module-workflow/src/server/features/omni-trigger/CustomActionTrigger.ts:255`

说明：general-action trigger 在触发前会根据 `filterByTk/filter/appends` 直接 `repository.find/findOne` 组装 payload，但这些读取没有传 `context: ctx`，也不会经过 `tenantResourceGuard` 合并租户 filter。

风险：即使最终 workflow trigger 传入 httpContext，进入 workflow 的 `data` 已经可能来自其他租户，尤其是手动动作配置了 filter 或 appends 时。

建议：所有 payload 读取都传 `context: ctx`，并显式复用租户过滤 helper 或保证进入 resourcer 过滤链路。

### 11. [暂缓处理] 分支仍包含测试基础设施迁移和仓库级配置改动，建议从租户隔离修复中拆开确认

涉及位置：

- `docs/superpowers/plans/2026-05-25-tego-core-test-infrastructure-migration-plan.md:1`
- `docs/superpowers/specs/2026-05-25-tego-core-test-infrastructure-migration-design.md:1`
- `pnpm-workspace.yaml:10`
- `pnpm-workspace.yaml:30`
- `.github/copilot-instructions.md:3`
- `AGENTS.md:3`
- `.gitignore:42`

说明：当前分支没有看到 `vitest.config.*` / `jest` 配置文件本身的 diff，但还包含测试基础设施迁移方案文档、`@tachybase/*` / `@tego/*` catalog 从 `1.6.11` 升到 `1.6.12`、AI 指南改写和 `.superpowers/.claude` ignore 规则。这些改动不直接属于租户隔离运行时能力，后续修复时容易和测试开发分支目标混在一起。

风险：合并租户隔离时把测试基础设施/依赖版本升级一起带入，增加回归面；也会让后续回滚或 cherry-pick 租户修复变复杂。

建议：如果这些改动确实是另一个测试开发分支的内容，本分支修复时建议剔除；如果必须保留，建议拆成单独提交并在提交说明中标明与租户隔离的关系。

## 待继续复核

已覆盖：

- 客户端租户切换和本地 current tenant 状态
- collection-manager 开关与 legacy 可见租户配置读写链路
- tenantResourceGuard 主路径和多数据源路径
- workflow trigger/execution/instruction 主要路径
- import/export worker 中 tenant context 传递
- file attachments 的上传、删除、列表隔离路径
- ACL、audit log、charts 边界路径
- 测试/配置污染：未发现 `vitest.config.*` / `jest` 配置文件 diff；发现文档、catalog/lockfile 和 AI 指南类范围风险

待继续复核：

- 用最终清单再过一遍是否有重复项可以合并，避免修复阶段重复劳动
