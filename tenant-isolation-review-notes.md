# Tenant isolation review notes

本文档记录 `feat/platform-tenant-isolation` 分支的租户隔离复核结论。2026-06-29 复核后，旧的“暂缓处理”结论已按当前代码状态重整；后续以本文件为准。

## 本轮复核结论

- 文档中多处旧风险已经被代码修复，需要同步为已完成或测试闭环风险。
- 本轮补强了 workflow 运行时代码边界测试，覆盖 `query/select/update/updateorcreate/destroy/aggregate/date-field schedule` 以及本地租户 helper，确保运行时不再静态依赖 `@tachybase/module-tenant`。
- 本轮确认 `module-user` 的程序化 `tenantId` 字段注入只在 tenant 插件存在且 `enabled` 时执行；tenant 插件不存在或被禁用时不会自动显示或执行租户字段注入。
- 未发现其他模块通过 `pm.get('tenant')` 直接绕过启用状态。前端租户管理入口和集合模板租户配置仅由 `module-tenant` 客户端插件注册。
- `packages/client` 的 `APIClient` 仍会在本地存在 `current_tenant_id` 时发送 `X-Tenant-Id`。租户模块未启用时服务端没有对应中间件消费该状态，当前判断为低风险；文档中保留为边界说明。

## 当前可确认完成

### 租户模块主能力

- `packages/module-tenant` 已提供前后端入口、`tenants`/`tenantUsers`/`users` 扩展集合、当前租户解析、切换接口和管理页面。
- 租户树已支持 `parentId/parent/children/path`、创建 path、移动子树重算 path、循环引用保护、删除非叶子节点保护和 path 长度友好校验。
- `setCurrentTenant` 已根据 `X-Tenant-Id`、默认租户和用户可用租户解析 `ctx.state.currentTenant/currentTenantId/currentTenantDescendantIds`；普通用户伪造不可访问租户会被拒绝，root 显式代入时保留 actor 审计元数据。
- `tenantResourceGuard` 覆盖主数据源和非默认数据源的 resourcer 路径，按集合 `tenancy` 设置 `currentTenancyMode/currentLegacyDataTenantIds` 并调用 `applyTenantFilter`。
- `applyTenantFilter` 对 `list/get/count/export` 加读过滤，对 `create` 强制写当前租户，对 `update/destroy` 加写过滤，并在 `update` 中移除请求体的 `tenantId`。
- `legacyDataTenantIds` 只影响读取旧数据，不放宽更新或删除。
- collection-manager 动态开关已在 `tenantScoped/tenantInherited` 启用时补 `tenantId` 字段并同步表结构。
- ACL 已内建 `tenant` scope；隔离兜底仍在资源层。

### 相关模块与插件适配

- `plugin-action-import` 的关联字段解析已向 relation lookup 传递 `context: ctx`，避免导入时跨租户匹配同名关联记录。
- `plugin-action-export` 已在异步 worker 中传递完整 `tenantContext`，包含 `currentTenancyMode/currentTenantDescendantIds/currentLegacyDataTenantIds`，并在 worker 内重新应用租户过滤和租户化文件路径。
- `plugin-block-charts` 已在服务端追加租户过滤，缓存 key 的 `tenantScope` 已包含 `tenancyMode`、descendants 和 `legacyDataTenantIds`。
- `module-file` 已将 `attachments` 标记为 `tenantScoped`，上传路径会进入 `tenants/<tenantId>`，删除前按 `context: ctx` 查询附件。
- `plugin-audit-logs` 已记录 `tenantId/actorUserId/impersonatedTenantId/tenantContextSource/isTenantImpersonation`，并已有租户字段迁移。
- `module-workflow` execution 已保存并恢复 `tenantContext`，包含 `currentLegacyDataTenantIds`。
- workflow `general-action` 同步和异步触发均传递 `{ httpContext: ctx }`，payload 查询已传 `context: ctx`。
- workflow `date-field schedule` 已按触发记录租户构造上下文，并在 `tenantInherited` 下查询 descendants。
- workflow 指令直连 repository 路径已显式调用本地租户 helper，覆盖 `QueryInstruction`、`SelectInstruction`、`UpdateInstruction`、`UpdateOrCreateInstruction`、`DestroyInstruction` 和 `AggregateInstruction`。
- `module-user` 的 `afterDefineCollection` 已同时覆盖 `tenantScoped/tenantInherited`，并增加 tenant 插件启用状态门禁。
- workflow executions、auditLogs、attachments 已有租户字段迁移脚本。

## 租户模块未启用或禁用时的边界

- `module-user`：`tenantId` context field 只在 `this.app.pm.get('tenant')?.enabled` 且集合声明 `tenantScoped/tenantInherited` 时注入。未安装 tenant 插件或 tenant 插件被禁用时不会注入。
- `module-workflow`：租户过滤 helper 本地实现，不静态导入 `@tachybase/module-tenant`。没有 `currentTenant/currentTenantId` 的上下文时 no-op；集合不是 `tenantScoped/tenantInherited` 时 no-op。
- `module-workflow`：`@tachybase/module-tenant` 仍在 `package.json` 的 `devDependencies` 中，用于测试和开发，不是运行时强加载路径。
- `module-file`：运行时代码未静态导入 `@tachybase/module-tenant`；测试 helper 会加载 tenant 插件。`package.json` 中的 tenant 依赖同样属于 dev/test 边界。
- 前端：租户菜单、租户管理页和集合模板里的租户配置由 `packages/module-tenant/src/client/index.ts` 注册。tenant 客户端插件未加载时，基础集合模板不会暴露 `tenancy/legacyDataTenantIds` 配置。
- `APIClient`：本地 storage 有 `current_tenant_id` 时会发送 `X-Tenant-Id`。tenant 服务端模块未启用时没有中间件消费该 header，不会单独触发租户隔离逻辑。

## 仍需跟踪

- `packages/module-file/src/server/__tests__/action.test.ts` 仍有 4 个 tenant 相关 skipped 用例，注释指向 test setup 尚未通过 tenant middleware 设置 `ctx.state.currentTenantId`。
- `packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts` 仍有 2 个 tenant 相关 skipped 用例，代码路径已实现，但测试装配仍未闭环。
- 统一隔离入口仍主要在 `module-tenant` 资源中间件和各插件显式 helper 中，后续如需更强“不可绕过”能力，可以继续评估向 `module-data-source` 或更底层收口。
- 历史数据“归类迁移工具”、灰度开关和回滚工具尚未实现。当前 `legacyDataTenantIds` 是读时兼容策略，不等同于完整迁移工具链。
- `available-tenants` 当前实现是“用户直接归属租户 + enabled 子孙租户”，不向上包含祖先租户。该行为已和当前测试一致，若产品要求“子可切父”，需要另行改设计和测试。
- 上线前仍需完整回归、压测和真实数据库迁移验证。

## 本轮新增或确认的验证点

- `packages/module-workflow/src/server/__tests__/tenant-module-boundary.test.ts`：确认 workflow tenant-aware 运行时代码不包含 `@tachybase/module-tenant` 静态依赖，并确认无租户上下文时本地 helper 不追加租户过滤。
- `packages/module-workflow/src/server/__tests__/instructions/tenant-filter.test.ts`：覆盖 query/select/update/updateorcreate/destroy/aggregate 的租户过滤。
- `packages/module-user/src/server/__tests__/fields.test.ts`：覆盖 tenant 插件不存在、存在但禁用时不注入 `tenantId` 字段。
