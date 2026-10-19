# 根记录分组统计实施计划

**目标：** 为后续图表提供按授权物理字段分组的内部统计能力，使用列表同一角色条件、G/V 和请求筛选。

**边界：** `groupAggregate` 接受 1–3 个不重复的根物理标量分组字段，及已有 `method/field/distinct/filter/transaction`。每组支持 count（字段非空计数）、sum、avg、min、max；返回 `{ key, value }`，空集合返回空数组。默认最多 1000 组，可下调，超限整体拒绝；按分组字段升序、NULL 最后排序。暂不提供关联字段分组、日期截断、HAVING、自定义排序、分组分页、SQL 或资源 action。

- [x] 在 `reads.test.ts` 先增加失败测试，覆盖五方法、角色/G/V/筛选相交、NULL、distinct、字段权限、关联可读性、输入快照、事务、元数据、组数上限和固定 SQL 次数。
- [x] 在 `reads.ts` 增加内部请求及结果类型和 `groupAggregate`，复用根查询计划和标量统计校验。分组字段在首次异步前固定，SQL 标识符取自已验证元数据并使用 ORM 引用；数据库完成分组，不能拉取全部明细再分组。
- [x] 在 `entry-reads.ts` 增加独立 `groupAggregate` 权限操作并委托读取服务，不注册接口或启用业务。
- [x] 完成 SQLite / 随机专用 PostgreSQL 根读取回归、类型、lint、格式、租户包构建及独立审查，更新设计进度并签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t grouped.aggregate --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。

## 验证记录

- 首轮 SQLite 新测试 16 项因缺少 `groupAggregate` 失败。实现后 SQLite / 随机专用 PostgreSQL 聚焦测试 32 项通过（12.02 秒）。
- 严格 TypeScript 0 项诊断、oxlint 0 错误/警告、Prettier、差异检查及租户包构建通过。ORM 的分组类型声明遗漏运行时支持的表达式，已核对实现并将类型适配限定在 `group` 参数，保留逐段引用物理标识符的 SQL。
- 独立审查无阻断项，并独立完成 SQLite 分组测试 16 项。根读取、一对多和多对多读取文件的完整双库回归 742 项通过（253.92 秒），覆盖共用查询计划的旧列表、详情、筛选和统计行为。
- 本轮所有随机专用 PostgreSQL 测试库均已删除并确认不存在；未修改核心、依赖、业务配置或业务数据库，没有注册新资源或启用业务。
