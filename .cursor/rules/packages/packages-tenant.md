---
description: Tenant isolation product semantics and cross-module implementation rules
globs:
  - packages/module-tenant/**/*
  - packages/module-workflow/src/server/**/*
  - packages/module-cron/src/server/**/*
  - packages/plugin-block-charts/src/server/**/*
  - packages/plugin-action-export/src/server/**/*
alwaysApply: false
---

# Tenant Isolation / 租户隔离

## Product Semantics / 产品语义

- `shared`: all tenants can access the data. Tenant middleware must not inject or query `tenantId` for a shared or otherwise non-tenant-aware collection.
- `shared`：所有租户可访问。对共享或其他未启用租户隔离的表，租户中间件不得注入或查询 `tenantId`。
- `tenantScoped`: only the tenant that owns a record can access it.
- `tenantScoped`：只有记录归属租户可以访问。
- `tenantInherited`: the owning tenant and its ancestor tenants can access a record. From the active tenant's perspective, this means access to records owned by itself and its descendant tenants.
- `tenantInherited`：记录归属租户及其父级租户可以访问。从当前租户视角看，可访问本租户及其下级租户的数据。
- Visibility controls reads, updates, deletes, and association references. Do not hard-code same-tenant checks where the collection mode allows inherited access.
- 数据可见性同时控制查看、修改、删除和关联引用。表配置允许父级访问时，不得写死为仅同租户可访问。

## Enforcement / 执行规则

- Tenant isolation is an additional data boundary, not an ACL replacement. A request must satisfy both action permission and tenant visibility; elevated role names do not implicitly bypass collection tenancy modes.
- 租户隔离是额外的数据边界，不能替代 ACL。请求必须同时满足操作权限与租户数据可见性；高权限角色名称本身不能自动绕过数据表的租户模式。
- Derive tenant behavior from each collection's effective runtime `options.tenancy`. Do not infer it from table names, the current page, a global fallback, or whether a physical `tenantId` column happens to exist.
- 租户行为必须取自每张表运行时生效的 `options.tenancy`。不得根据表名、当前页面、全局兜底值或物理表是否恰好存在 `tenantId` 列来推断。
- Enforce source and target collections independently for associations. A shared target such as `users` must never receive tenant predicates merely because its source is tenant-aware.
- 关联操作必须分别按来源表和目标表的配置校验。`users` 等共享目标表不能因为来源表启用了租户隔离就被附加租户条件。
- A missing tenant context must fail closed for tenant-aware reads and writes, but must not change behavior for shared collections.
- 租户表在缺少租户上下文时必须安全拒绝读写，但共享表的行为不得因此改变。
- Treat framework resource shapes as contracts. In particular, `/_/` is the core placeholder for direct association target `get`/`list`: skip only the absent source-record check and continue applying the target collection's tenant filter.
- 框架资源路径属于协议契约。尤其是 `/_/` 表示直接执行关联目标表的 `get`/`list`：只跳过不存在的来源记录校验，目标表的租户过滤仍必须执行。
- Apply the same semantics to normal resources, nested associations, charts, exports, imports, workflows, cron execution, and external data sources. Reuse shared tenant helpers instead of maintaining divergent copies where practical.
- 普通资源、嵌套关联、图表、导入导出、工作流、定时任务和外部数据源必须遵循同一语义。在可行范围内复用公共租户辅助函数，避免各模块维护分叉逻辑。

## Writes and Legacy Data / 写入与历史数据

- Creates in tenant-aware collections belong to the active tenant. Ordinary updates must not allow request values to reassign `tenantId`.
- 租户表新增记录归属当前租户。普通更新不得允许请求值直接改写 `tenantId`。
- Legacy data has `tenantId = null`. Only tenants listed in `legacyDataTenantIds` may read it.
- 历史数据的 `tenantId = null`。只有 `legacyDataTenantIds` 配置的租户可以查看。
- When `allowEditingLegacyData` is enabled, the first successful edit atomically claims the legacy record for the editor's active tenant. Without it, legacy data remains read-only. A reference to legacy data must not claim or mutate it.
- 开启 `allowEditingLegacyData` 后，首次成功编辑必须原子地将历史记录归属到编辑者当前租户；未开启时历史数据只读。仅关联引用历史数据时不得改变其归属或内容。
- Direct deletion of unassigned legacy data is not allowed. It must first be claimed through an allowed edit, then deleted under normal tenant rules.
- 未归属租户的历史数据不能直接删除。必须先通过允许的编辑完成归属，再按普通租户规则删除。

## Workflows and Background Jobs / 工作流与后台任务

- Preserve tenant context across workflow nodes, delayed jobs, retries, and background workers. Execution records and generated business data must retain the tenant that caused the work.
- 工作流节点、延迟任务、重试和后台 Worker 必须持续传递租户上下文。执行记录及生成的业务数据必须归属触发该任务的租户。
- Scheduled workflows that operate on tenant-aware data run once per eligible tenant and may create multiple execution records. Do not silently execute all tenant work under the root tenant.
- 操作租户数据的定时工作流应按符合条件的租户分别运行，因此一次调度可以产生多条执行记录。不得把所有租户任务静默归到根租户执行。

## Errors and Verification / 错误与验证

- User-facing tenant errors must use the module translation helpers and distinguish missing tenant context, inaccessible records or associations, and read-only legacy data.
- 面向用户的租户错误必须使用模块翻译辅助函数，并区分缺少租户上下文、记录或关联不可访问、历史数据只读等情况。
- For behavior changes, cover the relevant matrix: `shared`, `tenantScoped`, `tenantInherited`; current, descendant, unrelated, legacy, and missing tenant context; direct and association access where applicable.
- 行为变更应覆盖相关矩阵：`shared`、`tenantScoped`、`tenantInherited`；当前、下级、无关、历史数据及缺少租户上下文；必要时同时覆盖直接访问与关联访问。
- Run the focused `module-tenant` tests plus tests and package builds for every integration module touched. Use a real local browser/API workflow when the bug depends on persisted schemas, roles, or tenant selection.
- 运行聚焦的 `module-tenant` 测试，以及所有被修改集成模块的测试和包级构建。若 Bug 依赖已持久化 Schema、角色或租户选择，还需通过本地真实浏览器/API 流程验证。
