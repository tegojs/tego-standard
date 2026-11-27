# 数量与金额汇总参数适配计划

**目标：** 内部计数、根字段求和入口与列表复用筛选、日期、角色权限和 G/V 规则。

**边界：** 核心 `count` action 只转发 `filter`；求和沿用内部 `sum` 的 `field` / `filter` 契约，不冒充通用 `aggregate` action。事务、身份、日期上下文只能由可信调用者独立传入。计数和求和分别按自己的操作解析最终权限，不能借用列表权限。仍不注册业务路由、不启用业务配置、不修改核心和依赖。

## 文件与步骤

- [x] `resource-read-params.test.ts`、`reads.test.ts`：先写参数和真实数据库日期汇总用例，确认旧实现因缺少新入口失败。
- [x] `resource-read-params.ts`：扩展原有严格捕获，仅允许计数的筛选和内部求和的根字段、筛选；拒绝分页、投影、底层 SQL、伪造身份/事务及其他参数。
- [x] `entry-reads.ts`：增加 `countFromParams`、`sumFromParams`；复用 `withDates` 和现有读服务，避免重复查询与授权实现。
- [x] 验证日期边界、关联目标权限、独立操作权限、字段权限、无结果、参数快照、事务和 SQL 前拒绝。
- [x] SQLite / 随机独立 PostgreSQL 测试，严格类型、lint、格式及租户包构建；独立审查后签名原子提交。

## 验证记录

- 红灯验证：两个参数解析器及真实日期汇总因缺少新入口失败；实现后通过。
- 参数解析、日期快捷变量、请求筛选与根读取共 4 个文件，SQLite / 随机独立 PostgreSQL 共 394 项通过（164.85 秒）。随后加强访问器断言，4 项双数据库聚焦复核通过（7.50 秒）。两个专用测试库均已删除并确认不存在，未触碰业务库。
- 严格 TypeScript：0 项诊断；4 个代码文件 oxlint：0 错误、0 警告；Prettier 与租户包构建通过。
- 独立审查无待修问题：核对独立操作权限、字段及关联权限、角色/G/V/请求交集、同步捕获、可信事务/日期传递及旧参数行为。新增入口未增加数据库查询，原查询执行器保持不变。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/resource-read-params.test.ts packages/module-tenant/src/server/__tests__/access-control/read-date-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。PostgreSQL 使用随机独立本地测试库，完成后删除并核实。
