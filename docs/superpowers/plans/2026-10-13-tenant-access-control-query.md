# 租户访问模型：统一查询服务实现计划

> 按 writing-plans、executing-plans 和 test-driven-development 在当前新分支执行，验证后按职责提交，不启用业务表、不修改依赖或业务数据。

**目标：** 从同一个权威配置快照、真实模型和可信身份生成 G/V，并将范围与既有 Sequelize 条件相交，供根记录列表、计数、汇总及写前检查共同使用。

**架构：** 新增内部 `AccessQueryService`，复用 `AccessAclScopeAdapter.configuration`、`resolveAccessContext`、`resolveModelMetadata` 和 `compileAccessScopes`。调用者先完成角色 ACL 与请求条件解析；服务只追加数据范围，不能覆盖原条件。此阶段不提供自动 Repository 拦截，也不开放未适配的关联展开。

**技术栈：** TypeScript、Sequelize、Vitest、内存 SQLite。

## 1. 参数绑定互不覆盖

文件：`packages/module-tenant/src/server/access-control/types.ts`、`compile.ts`、`__tests__/access-control/compile.test.ts`。

- [x] 先验证指定绑定命名空间和非法命名空间，再实现可选 `parameterPrefix`；默认保持原编译结果。
- [x] 查询服务为本次新增范围选取不与原命名绑定冲突的前缀；不得用文本替换修改带引号的 SQL 标识符。

## 2. 同一快照的查询服务

文件：`packages/module-tenant/src/server/access-control/query.ts`、`__tests__/access-control/query.test.ts`。

- [x] 先用真实 Collection、持久化配置和租户记录写失败测试，验证总部、分公司、兄弟租户的读取集合、计数和金额合计。
- [x] 实现 `resolveScopes`，校验真实模型稳定标识，复用已准备配置，并在提供的事务中解析授权身份与层级；未迁移返回 null，未准备或失效阶段报错。
- [x] 实现 `scopeQuery`，按 read / ownership 选择范围，与原 where 用 AND 合并，保留原绑定和事务，不修改调用者对象。
- [x] 验证 V 仅扩大读取、G 限制写前选择、ACL 与请求条件保留、多条关系匹配不重复、缺少身份拒绝、共享配置无需租户，以及参数绑定冲突。
- [x] 验证配置变更不改变已开始阶段，新阶段读取新版本；伪造或重建表标识、已结束/其他数据库事务明确拒绝。

使用示例（内部服务器调用，非客户端参数）：

```typescript
const plan = await service.scopeQuery(ctx, tableIdentity, authenticatedIdentity, {
  where: parsedRoleAndRequestWhere,
  bind: existingNamedBindings,
  transaction,
});
// 只有非 null 的计划代表该表已经迁移；根查询使用 plan.query。
```

## 3. 验证与使用边界

- [x] 运行新服务测试、已有规则与 ACL 契约测试、oxlint、Prettier、严格类型检查及租户模块构建。
- [x] 复查插件入口没有注册新服务，实际业务库与线上无更改。

实际验证：根查询服务 18 个场景分别在 SQLite 和独立 PostgreSQL 执行，共 36 项；规则编译 55 项通过。连同权威配置、角色契约、真实模型、可信身份、PostgreSQL 并发原型及旧过滤/历史认领回归，13 个文件、245 项通过，无跳过。租户模块构建、严格类型检查和 30 个 TypeScript 文件的 oxlint 通过。独立测试库已删除。

PostgreSQL 测试文件使用同一临时库及固定测试表名，联合运行必须加 `--no-file-parallelism`，避免文件间创建/清理冲突；各测试内部的并发事务照常执行。未配置专用 PostgreSQL 连接时只运行 SQLite 场景，不能把这视为 PostgreSQL 已通过。

独立审查发现异步身份查询期间替换模型可能复用旧范围，已用失败测试确认并修复：查询完成后再次检查实际 Collection、Model 和稳定 key，随后同步解析当前元数据并编译。请求阶段结束或替换也明确拒绝；固定查询事务在异步调用前捕获。复审无其他具体问题。

本阶段只形成根查询谓词能力。关联筛选/排序/展开、事务内写入与历史认领、工作流和管理页面仍需要各自适配；不能将返回的根范围作为这些入口已受保护的证明。
