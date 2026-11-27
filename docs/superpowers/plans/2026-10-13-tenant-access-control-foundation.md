# 租户访问规则基础实现计划

**目标：** 在独立测试中实现同一规则模型的归属性和可见性计算，证明条件不会意外放行、关联匹配不重复根记录。此阶段不接入业务请求，也不迁移现有配置。

**架构：** `module-tenant` 内提供经过校验的条件结构及参数化 SQL 编译器。字段和关系来自服务端元数据；所有条件值使用绑定参数，关联条件使用相关 `EXISTS`。两类规则共享编译过程，读取取并集、写入仅取归属性范围。

**技术栈：** TypeScript、Vitest、现有 Sequelize 数据库；SQLite 验证可重复的查询行为，独立 PostgreSQL 测试库验证执行计划及事务。

设计依据：[租户归属性与可见性](../specs/2026-10-13-tenant-access-control-design.md)。在当前新分支顺序执行；无需修改现有业务数据库或依赖。

## 文件与职责

- `packages/module-tenant/src/server/access-control/types.ts`：两类规则、条件及服务端字段/关系元数据契约。
- `packages/module-tenant/src/server/access-control/validate.ts`：拒绝非法结构、未知字段、不支持关系和缺失上下文。
- `packages/module-tenant/src/server/access-control/compile.ts`：生成归属性、可见性及合并读取的参数化 SQL 条件。
- `packages/module-tenant/src/server/__tests__/access-control/compile.test.ts`：规则结构和拒绝边界。
- `packages/module-tenant/src/server/__tests__/access-control/query.test.ts`：设计文档中的 D1—D6 查询集合、计数和金额断言。
- `packages/module-tenant/src/server/__tests__/access-control/postgres.test.ts`：独立 PostgreSQL 库中的关系并发和 SQL 计划；未提供专用连接时明确跳过。

## 任务 1：先固定规则计算结果

- [x] 编写测试：H 读取 D1、D2、D6；B 读取 D1、D3 且只能写 D3；C 读取 D4、D6；D5 默认不可访问。D6 的 B 和 C 条件不能拼接匹配。
- [x] 编写空规则、缺变量、非法字段、NULL 取反及 SQL 参数注入测试。
- [x] 运行测试，确认因功能缺失失败，再实现类型、校验及编译器。

调用契约：

```typescript
const scopes = compileAccessScopes(config, {
  collection: rootMetadata,
  context: { 'tenant.id': 'B' },
  quoteIdentifier,
});
// scopes.read.sql：G OR V；scopes.ownership.sql：G。
// scopes.read.bind / scopes.ownership.bind：各自 SQL 实际使用的命名参数。
```

验证命令：

```powershell
pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/compile.test.ts --reporter=default
```

## 任务 2：在实际数据库执行同一条件

- [x] 在内存 SQLite 创建独立测试表和关系，写入 D1—D6。
- [x] 使用编译条件执行列表、计数、求和和带额外业务筛选的查询；断言根记录集合、总数和金额符合设计文档。
- [x] 覆盖单值、一对多、多对多、字段映射及最多 3 层关系；超限或未知路径必须拒绝。
- [x] 对比 20 条和 100 条分页的权限查询次数，确认编译不读取大量关联 ID，也不逐条查权限。

```powershell
pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/query.test.ts --reporter=default
```

## 任务 3：验证 PostgreSQL 能力

- [x] 创建独立测试数据库，通过专用测试连接运行；测试禁止使用业务数据库连接作为默认值。
- [x] 执行相同的读取集合断言与 `EXPLAIN`，验证相关查询及绑定参数。
- [x] 用两个连接验证串行化事务中的关系撤销、否定存在与写入竞争，以及撤权提交后的新写入拒绝。
- [x] 记录结果与限制；未验证的数据库能力不得宣称可用。

```powershell
pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/postgres.test.ts --reporter=default
```

## 本阶段完成检查

- [x] 聚焦测试、修改文件的 oxlint 和 Prettier 检查通过。
- [x] 相关包构建通过；不提交生成产物。
- [x] 审查没有修改现有租户守卫、核心全局关联行为和业务数据库。
- [x] 更新本文和设计文档中的实际结果，清楚区分已经验证的能力与下一阶段业务接入。

## 实际结果与下一阶段边界

已实现规则类型、结构校验和参数化 SQL 编译。联合验证共 5 个测试文件、107 项测试通过：规则校验和编译 46 项、SQLite 查询 29 项、PostgreSQL 原型 9 项，以及现有租户过滤与历史认领回归 23 项。PostgreSQL 原型覆盖并发关系撤销、否定存在、层级变更和历史数据竞争认领。租户模块构建、实现文件严格类型检查及新增 TypeScript 文件的 oxlint 检查通过。

在 20006 条单据、40004 条参与方的独立样例中，B 读取 1002 条单据，金额合计 100400，没有重复计数。首次测量的 20 条与 100 条分页数据库执行时间分别约为 2.7 ms、3.2 ms（各 5 次的最慢一次）。这只证明样例查询形状可行，不代表真实仓库页面性能已经验收。

原型发现并修正了读写范围参数混用、相关子查询别名冲突，以及合法空层级列表的处理。每个 SQL 范围只携带自己使用的绑定参数。新增代码没有被租户插件运行入口导入，现有请求、配置和业务数据保持原行为。

真实模型适配及可信身份、层级解析现已完成独立验证，结果见[真实模型适配计划](2026-10-13-tenant-access-control-adapters.md)。接下来仍需角色条件合并及权威配置版本加载，随后接入根资源及关联入口，并做逐表启用检查。第一阶段样例性能不代表业务入口已经验收。

此阶段不提供可被客户端直接提交的 SQL 计划接口，也未实现业务写入守卫、配置保存、管理页面或旧配置迁移。
