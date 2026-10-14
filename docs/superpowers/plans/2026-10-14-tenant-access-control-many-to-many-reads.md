# 多对多关联读取实现计划

> 使用 executing-plans 在当前功能分支内执行；沿用已批准的归属性与可见性设计。

**目标：** 多对多目标列表、计数和根字段合计同时满足来源、目标与中间记录各自的读取范围，重复连接不重复计算。

**架构：** 新增独立读取元数据解析器和查询计划服务，复用 `AccessQueryService`。使用相关 `EXISTS` 检查中间记录，不加载关联 ID，不改变现有写入适配器或全局关联查询。

**技术栈：** TypeScript、Sequelize、Vitest、SQLite、独立 PostgreSQL 测试库。

## 边界

- 来源、目标、中间表均须明确准备新模型配置；普通连接表使用显式共享配置，业务中间表使用自己的 G/V，缺配置拒绝。
- 入口负责操作权限与字段权限，并传入三表分别解析的 ACL 数据条件；本服务只组合可信条件。
- 具体来源先检查读取权限，再用真实连接键及中间表 G/V、ACL、scope、默认范围和软删除条件限制目标。
- `/_/` 按核心协议直接读目标，不要求存在来源或连接；仍检查目标 G/V、ACL 与关联目标 scope。
- 不同查询片段的同名参数拒绝合并，避免覆盖；内部参数自动避让。
- 所有输入在异步执行前复制；保留真实事务。异步后复核三表身份、配置版本与关联元数据。

## 实施步骤

- [x] 新增 `packages/module-tenant/src/server/__tests__/access-control/many-to-many-reads.test.ts`，先确认缺少模块，再以未实现服务得到真实行为红灯。
- [x] 新增 `packages/module-tenant/src/server/access-control/many-to-many-read-metadata.ts`，仅接受已登记、同数据库、单主键多对多关系，读取支持独立业务中间表。
- [x] 新增 `packages/module-tenant/src/server/access-control/many-to-many-reads.ts`，提供 `scopeTargets(ctx, source, target, through, authenticated, request)`，返回可复用的目标查询计划。
- [x] 验证来源/目标/连接各自 G、V、历史与隐藏范围，三表 ACL，空关系、重复关系、分页计数合计，物理字段名、scope、事务、输入快照及失效检查。
- [x] 在 SQLite 与随机独立 PostgreSQL 数据库串行运行新测试及多对多写入、目标外键读取回归：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/many-to-many-reads.test.ts packages/module-tenant/src/server/__tests__/access-control/many-to-many.test.ts packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-reads.test.ts --maxWorkers=1 --no-file-parallelism`。
- [x] 运行 module-tenant 构建、变更运行时代码严格类型检查、oxlint、Prettier 与差异检查；独立审查无有效问题，准备签名原子提交。

## 验证结果

- 首轮联合回归 3 个文件、182 项全部通过，无跳过。最后统一中间表查询别名，并补充关系型 V 与禁止绕过软删除两项测试后，读取文件单独重跑，SQLite 和 PostgreSQL 各 42 项、共 84 项全部通过；既有关系读写回归共 102 项通过。
- 物理列映射使用当前 ORM 自带转换；中间表沿用已登记模型别名，兼容入口解析的 ACL 表达式。三表配置、关系身份、scope 与列名在异步过程变化时拒绝返回过期结果。
- 同一来源的可读目标从 3 条增加到 53 条时，权限与目标查询总次数不变且不超过 5 次；列表、计数及根字段合计没有重复。这里不是实际业务页面性能验收。
- `pnpm exec tegod build @tachybase/module-tenant` 成功；变更运行时代码使用已构建公共依赖类型的严格 TypeScript 检查为 0 错误；3 个代码及测试文件 oxlint 为 0 警告、0 错误。
- 两轮随机独立 PostgreSQL 测试库均已精确删除。独立审查及最终改动复审均未发现有效问题。

## 本阶段不包含

批量关联展开、跨关联筛选排序、业务中间表写入和业务入口启用仍需分别实现和验收。测试只修改专用测试库。
