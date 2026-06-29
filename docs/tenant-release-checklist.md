# 租户隔离 — 合并前回归清单

> 最小必跑集合，覆盖各模块租户相关风险点。全部使用 Vitest server project。

## 一键全跑

```bash
npx vitest run --project server \
  packages/module-tenant/src/server/__tests__/ \
  packages/module-workflow/src/server/__tests__/ \
  packages/plugin-action-export/src/server/__tests__/ \
  packages/module-file/src/server/__tests__/ \
  packages/plugin-block-charts/src/server/__tests__/ \
  packages/plugin-audit-logs/src/server/__tests__/
```

---

## 逐模块命令

### module-tenant — 资源守卫 / 禁用边界 / 外部数据源

```bash
npx vitest run --project server packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts
```
CRUD 自动注入 tenantId 并限制到当前租户；无租户上下文时拒绝操作。

```bash
npx vitest run --project server packages/module-tenant/src/server/__tests__/plugin-disabled.test.ts
```
模块未加载时应用正常启动，不注册任何租户相关插件/集合/ACL。

```bash
npx vitest run --project server packages/module-tenant/src/server/__tests__/tenant-datasource-guard.test.ts
```
外部数据源按租户过滤；模块禁用时透传不拦截。

### module-workflow — 租户过滤 / SQL 权限 / trigger 入口

```bash
npx vitest run --project server packages/module-workflow/src/server/__tests__/instructions/tenant-filter.test.ts
```
工作流指令（query/update/destroy/create/aggregate）按执行租户隔离；SQL 指令不做租户过滤。

```bash
npx vitest run --project server packages/module-workflow/src/server/__tests__/instructions/sql-permission-boundary.test.ts
```
SQL 节点仅 admin 可创建/编辑；执行权限在 API / trigger / processor 三层拦截。

```bash
npx vitest run --project server packages/module-workflow/src/server/__tests__/triggers/collection.test.ts
```
collection trigger 上下文持久化租户信息；跨数据源关联在租户范围内访问。

```bash
npx vitest run --project server packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts
```
定时触发对 tenant-scoped 记录持久化租户上下文；tenant-inherited 记录正确展开后代租户。

### plugin-action-export — 同步/异步导出租户上下文

```bash
npx vitest run --project server packages/plugin-action-export/src/server/__tests__/worker-export.test.ts
```
异步 worker 导出时携带完整租户上下文，查询结果限于当前租户。

```bash
npx vitest run --project server packages/plugin-action-export/src/server/__tests__/export-threshold.test.ts
```
批量导出超阈值时发出安全审计事件；阈值以下或无租户上下文时不触发。

### module-file — 附件路径和删除隔离

```bash
npx vitest run --project server packages/module-file/src/server/__tests__/action.test.ts
```
文件上传路径按租户隔离；删除操作仅限当前租户的附件。

### plugin-block-charts — 查询和缓存隔离

```bash
npx vitest run --project server packages/plugin-block-charts/src/server/__tests__/query.test.ts
```
图表缓存按租户 / 用户 / 查询条件 / 继承租户后代隔离；applyTenantScope 追加租户过滤并剥离冗余条件。

### plugin-audit-logs — 安全事件

```bash
npx vitest run --project server packages/plugin-audit-logs/src/server/__tests__/security-events.test.ts
```
记录 tenant_access_denied / cross_tenant_attempt / impersonation / bulk_export_alert 四类安全事件；不影响正常 CRUD。
