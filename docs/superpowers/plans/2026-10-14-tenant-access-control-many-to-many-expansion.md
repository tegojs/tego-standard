# 多对多批量展开计划

沿用已批准的归属性与可见性设计，在 `feat/tenant-access-control` 新增内部 `AccessManyToManyExpansionService`。不接入业务入口，不修改业务数据、依赖或核心仓库。

## 实现与验证

- [x] 新增 `packages/module-tenant/src/server/__tests__/access-control/many-to-many-expansion.test.ts`，先确认缺少批量展开能力时失败。以真实 SQLite/PostgreSQL 表覆盖来源、目标、中间表各自的 G/V 与独立 ACL 条件。
- [x] 新增 `packages/module-tenant/src/server/access-control/many-to-many-expansion.ts`，复用 `resolveManyToManyRead` 与 `accessMetadataGuard`。输入最多 1000 个明确来源主键；来源整体校验，隐藏来源拒绝，隐藏目标或连接返回空数组。入口负责操作和字段 ACL，并分别提交三张表的服务端解析条件。
- [x] 来源只查一次。目标与可读连接在 SQL 中连接，中间表先按来源/目标键去重，避免重复连接扩增结果，不先加载大量关联 ID。按来源键及目标主键稳定排序，最多 10000 对可读关联，超限整体拒绝。仅返回入口明确授权的物理目标字段，不返回连接内容、内部键或虚拟 getter。
- [x] 覆盖默认范围、关联 scope、软删除、历史数据不认领、共享表无租户列、独立参数绑定、事务、输入快照、配置及元数据变化。拒绝 `_`、跨库、错误关联、未准备配置、稀疏数组、额外选项和字段表达式。
- [x] 比较 20/100 来源的 SQL 次数；验证重复连接超过上限但唯一关联未超限时不误拒绝，真正超过 10000 对时明确拒绝。
- [x] 运行新测试及已有多对多读取、两类批量展开的 SQLite/PostgreSQL 回归，清理随机独立测试库；完成严格类型、格式、lint、租户模块构建和独立复核。

命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/many-to-many-expansion.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 复用专用随机测试库运行器，禁止对业务库运行建表或清理命令。

## 验证结果

新能力先通过 SQLite 59 项，再与已有多对多读取、BelongsTo/HasMany/HasOne 展开及元数据快照一起完成双数据库 5 文件 372 项回归。独立复核发现字符串主键会接受 `_` 占位符；新增实际存在该键的字符串来源测试，确认修前失败，再显式拒绝占位符。最终新版双数据库 120 项全部通过，独立复核另行运行 SQLite 60 项全部通过，无剩余待修问题。两次随机独立 PostgreSQL 测试库均已删除。

严格运行时 TypeScript 检查为 0 诊断；两份代码和测试文件 lint 无警告或错误，格式检查及租户模块构建通过。所有新增能力仍为内部接口，未接入业务；完成验证后签名原子提交，不推送。

关联筛选排序、业务入口、配置界面及真实业务试点属于之后的阶段。
