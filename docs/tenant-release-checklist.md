# 租户隔离合并前回归清单

合并 `feat/platform-tenant-isolation` 前，reviewer/CI 必跑以下命令。全部通过即可合并。

## 一键全量

```bash
pnpm ts -- --testPathPattern="tenant|security-events"
```

覆盖所有租户相关服务端测试，包括以下各项。如果全量通过，可跳过下面分项。

## 分项验证

### 1. module-tenant 核心守卫

```bash
pnpm ts -- packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts
pnpm ts -- packages/module-tenant/src/server/__tests__/plugin-disabled.test.ts
pnpm ts -- packages/module-tenant/src/server/__tests__/tenant-datasource-guard.test.ts
```

- **resource-guard**: CRUD 全链路注入/校验 `tenantId`，防止跨租户读写。
- **plugin-disabled**: 未加载租户模块时服务正常启动，确认 no-op 无副作用。
- **datasource-guard**: 外部数据源查询自动注入租户过滤条件。

### 2. module-workflow 租户过滤与 SQL 权限

```bash
pnpm ts -- packages/module-workflow/src/server/__tests__/tenant-drift.test.ts
pnpm ts -- packages/module-workflow/src/server/__tests__/instructions/tenant-filter.test.ts
pnpm ts -- packages/module-workflow/src/server/__tests__/tenant-module-boundary.test.ts
```

- **drift**: workflow 本地过滤实现与 module-tenant 权威实现一致，防漂移。
- **tenant-filter**: Query/Select/Update/Destroy 指令对 `tenantScoped` 集合注入过滤。
- **module-boundary**: workflow 运行时不直接 import module-tenant，无租户上下文时过滤自动跳过。

### 3. plugin-action-export 导出租户上下文

```bash
pnpm ts -- packages/plugin-action-export/src/server/__tests__/tenant-drift.test.ts
```

- 同步/异步导出均强制绑定当前租户，客户端传入的外部 `tenantId` 被覆盖。

### 4. module-file 附件隔离

```bash
pnpm ts -- packages/module-file/src/server/__tests__/tenant-fields-migration.test.ts
```

- `attachments` 表包含 `tenantId` 字段，迁移幂等。附件路径和删除操作受租户上下文约束。

### 5. plugin-block-charts 查询与缓存隔离

```bash
pnpm ts -- packages/plugin-block-charts/src/server/__tests__/tenant-drift.test.ts
```

- 图表查询的 `applyTenantScope` 与 module-tenant 权威实现一致，缓存键含租户标识。

### 6. plugin-audit-logs 安全事件

```bash
pnpm ts -- packages/plugin-audit-logs/src/server/__tests__/tenant-fields-migration.test.ts
pnpm ts -- packages/plugin-audit-logs/src/server/__tests__/security-events.test.ts
```

- `auditLogs` 表包含租户字段，迁移幂等。
- 安全事件记录携带租户上下文，跨租户不可见。

### 7. 跨模块边界（推荐）

```bash
pnpm ts -- packages/module-tenant/src/server/__tests__/tenant-noop.test.ts
pnpm ts -- packages/module-collection/src/server/__tests__/tenant-isolation-boundary.test.ts
```

- **noop**: charts/export/file/workflow/audit 在无租户上下文时行为不变。
- **isolation-boundary**: collection 层隔离边界完整性。

## 判定标准

- 全部用例通过 → 可合并。
- 任一失败 → 阻塞合并，修复后重跑。
