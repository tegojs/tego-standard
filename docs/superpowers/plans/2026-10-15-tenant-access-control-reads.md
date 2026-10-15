# 统一根记录读取实现计划

沿用已确认的 G（归属性）和 V（可见性）设计，在现有功能分支执行；仅使用独立测试库，不启用业务接口。

## 范围

- 新增 `packages/module-tenant/src/server/access-control/reads.ts`，提供内部 `AccessReadService.list/get/count/sum`。入口仍负责操作 ACL，并提供可信读取授权 resolver；用户只能提交受限 JSON 筛选、字段名、排序和分页。
- 四类读取统一使用 `AccessRequestFilterParser` 和 `AccessFilterTreeService`，保留角色条件、G/V、默认范围和软删除。列表排序复用 `AccessSortService`，不扩增根记录。
- 在 `sort.ts` 增加同步 `prepareRoots`：先捕获授权、关系及元数据，再异步组合已编译的筛选。现有 `scopeRoots` 委托该流程，行为不变。
- `query.ts` 和 `filter-tree.ts` 接收内部 `reservedBindNames`，提前避让后续排序使用的命名参数，但不附加未使用的绑定值；SQLite 计数和金额不能因此报错。
- 每次读取按路径固定 resolver 结果，首次 await 前完成字段、筛选和排序授权快照。数据库执行前后验证全部计划；阶段结束或元数据变化时拒绝返回结果。
- 列表和详情只投影明确授权的物理字段，直接读取数据值，不执行 getter，不附带内部主键。列表默认 20 条，最多 1000 条，offset 为 0 至 1000000 的安全整数。
- 详情接受单个明确主键，不存在或不可读统一返回 `null`。计数不受分页/排序影响；合计只允许已授权的根物理数值字段，空集合保留 ORM 的 `null`。
- 拒绝额外 ORM 参数、表达式、虚拟字段、稀疏数组和访问器。关联展开、分组、日期快捷运算符、未迁移表及业务入口不在此阶段接入。

## 实施和验收

- [x] 在 `server/__tests__/access-control/reads.test.ts` 编写真实 SQLite/PostgreSQL 测试，先确认缺少统一服务时失败。
- [x] 实现同步排序准备与统一读取；验证同一筛选下列表、详情、计数、金额集合一致，隐藏关联不泄露值、根记录不重复。
- [x] 验证字段授权、getter、主键投影、非法请求、分页、事务、共享模型、默认范围/软删除和读取阶段变化。
- [x] 在首次异步权限查询期间修改请求、grant 和仅排序关联元数据，验证快照保持及变化拒绝；20/100 条分页 SQL 次数一致。
- [x] 运行 reads/sort/request-filter/filter-tree/query 的聚焦双库回归、严格类型、lint、格式和租户包构建，独立审查后原子化签名提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/sort.test.ts packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/filter-tree.test.ts packages/module-tenant/src/server/__tests__/access-control/query.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 使用随机命名的本地专用库，退出后删除并确认。

使用示例：入口固定当前身份及表身份，并从该操作 ACL 构造 resolver；调用 `reads.list(ctx, identity, authenticated, { attributes: ['name', 'amount'], filter: { project: { name: { $includes: '机场' } } }, sort: ['project.name'], limit: 20 })`。计数和合计传相同 `filter`，合计另传 `field: 'amount'`。不得从客户端传入 ACL 谓词或查询计划。

验证记录（2026-10-15）：上述五组 SQLite/PostgreSQL 聚焦回归共 272 项通过；随后加强共享表用例，实际移除租户列后再次双库验证，两项均通过。专用 PostgreSQL 测试库均已删除并确认。严格 TypeScript 为 0 诊断，oxlint 为 0 警告及错误，Prettier 和 `pnpm exec tegod build @tachybase/module-tenant` 通过。独立审查发现的排序参数冲突及大 JSON 输出误用输入限制，已分别通过失败回归重现并修复，复核无新增具体缺陷；排序准备结果的并发复用和不附加未使用参数也有直接回归覆盖。
