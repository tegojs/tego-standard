# 关联记录数值统计实施计划

**目标：** 具体来源的一对多、多对多统计复用根记录 aggregate 服务，来源、目标和中间记录分别满足角色权限及 G/V。

**边界：** 仅增加内部 `aggregateAssociation`，参数为具体来源描述符、`method/field/distinct/filter`，事务和日期上下文由服务端另传。支持已有 `avg/count/min/max/sum` 标量统计，不定义 aggregate 资源 action、不注册中间件、不启用业务。单值关联、占位来源、任意 SQL 和分组仍明确拒绝。

- [x] 在 `target-foreign-key-reads.test.ts`、`many-to-many-reads.test.ts` 增加失败测试。验证五种统计、空集合、NULL、值去重与连接去重、独立操作/字段授权、角色/G/V/请求交集、隐藏来源、输入快照、事务、日期、元数据变化、历史只读及固定查询次数。
- [x] 在 `access-control/entry-reads.ts` 增加 `aggregateAssociation`。首次权限回调前捕获统计参数，复用 `associationSelection` 和 `AccessReadService.aggregate`；仅扩展内部操作种类，来源约束不传播到目标的关联展开或角色内部事实。
- [x] 运行两个关联读取文件和根读取文件的 SQLite / 随机专用 PostgreSQL 回归，严格类型、oxlint、Prettier、租户包构建。独立审查后更新设计进度并签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-reads.test.ts packages/module-tenant/src/server/__tests__/access-control/many-to-many-reads.test.ts -t association.scalar.aggregate --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。

## 验证记录

- 首轮 SQLite 新测试 21 项因缺少 `aggregateAssociation` 失败。实现后 SQLite / 随机专用 PostgreSQL 聚焦测试 42 项全部通过（38.09 秒），专用数据库已删除。
- 严格 TypeScript 0 项诊断、oxlint 0 错误/警告、Prettier 与差异检查、租户包构建通过。独立静态审查无阻塞问题。
- 两个关联读取文件和根读取文件完整双库回归 710 项全部通过（472.90 秒），包括已有列表、详情、角色条件、关联筛选、日期、统计和事务行为；本轮所有随机专用 PostgreSQL 库均已删除并确认不存在。
- 仅新增内部入口，未注册资源、启用业务、修改核心、依赖、业务配置或业务数据库。
