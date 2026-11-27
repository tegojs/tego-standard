# 关联数据汇总读取计划

**目标：** 一对多、多对多的独立计数和内部根字段求和，与关联列表使用相同的来源、目标、中间表访问范围。

**边界：** 复用现有关系准备器和 `AccessReadService`，分别捕获 count/sum 的最终权限。核心只支持具体来源的多记录关联 count；`/_/` 只对 get/list 有直读语义，因此不扩展占位符汇总。sum 保持内部契约，不映射通用 aggregate，也不注册业务接口。单记录关系不扩展列表或汇总协议。不更改核心、依赖、业务数据和业务配置。

## 实施与验收

- [x] 在现有 `target-foreign-key-reads.test.ts`、`many-to-many-reads.test.ts` 增加关联汇总用例；在 `resource-read-routing.test.ts` 增加具体来源 count 的路由用例。先确认缺少入口和路由导致失败。
- [x] `entry-reads.ts`：关联准备流程接收类型明确的参数解析回调，保留原有列表、详情规则；增加 `countAssociationFromParams`、`sumAssociationFromParams`，复用根约束执行计数、求和。
- [x] `resource-read-routing.ts`：只开放具体来源 HasMany/BelongsToMany count，仍拒绝单记录 count、占位符 count 和关联 sum 路由。
- [x] 验证 G/V、独立角色权限、请求筛选、重复中间行、关联及默认 scope、历史数据不归属、隐藏外键、字段权限、日期、事务、同步快照和执行期间的权限/元数据变化。无效输入在 SQL 前拒绝。
- [x] 在 SQLite 和随机独立 PostgreSQL 库回归两个关联读取文件、根读取和路由；检查严格类型、lint、格式、租户包构建。独立审查后签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-reads.test.ts packages/module-tenant/src/server/__tests__/access-control/many-to-many-reads.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/resource-read-routing.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。

## 验证记录

- 红灯：新增 14 项 SQLite 汇总/路由用例因缺少入口和不支持 count 路由失败；实现后 14 项通过。
- 四文件 SQLite / 独立 PostgreSQL 联合回归执行 673 项（418.17 秒），671 项通过；仅同一个旧拒绝矩阵在两种数据库失败，因为仍将本次开放的具体 HasMany count 当作不支持。将该项改为单值关联 count，另加占位符 count 拒绝；修正用例双数据库聚焦复核 2 项通过（5.45 秒）。最终 673 项相关用例均取得通过结果，生产实现未在联合回归后改动。两个随机专用 PostgreSQL 库均已删除并确认不存在。
- 新增测试覆盖重复连接、三层角色权限/G/V、独立 count/sum 操作、父级字段路径、空字段计数、隐藏关系事实与实际筛选的区别、历史数据不认领、目标日期和活跃事务、快照与元数据复核、共享表无租户列及查询数不随记录增加。
- 严格 TypeScript：0 项诊断；5 个代码文件 oxlint：0 错误、0 警告；Prettier、差异检查及租户包构建通过。
- 独立审查复核旧矩阵修正及新增测试后无待修问题；独立 SQLite 三文件回归其余 244 项通过，修正项单独复核通过。未更改核心、依赖或业务数据库，未注册业务路由。
