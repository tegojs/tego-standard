# 根记录数值统计实施计划

**目标：** 让内部数值统计与列表使用同一套角色权限、G/V 和请求筛选，供后续图表入口复用。

**边界：** 核心 Repository 支持 `avg/count/min/max/sum` 和 `distinct`，但没有通用 aggregate 资源 action。本阶段只增加内部 `aggregate`，不扩展资源路由、不注册中间件、不修改核心或业务。所有方法要求明确的物理字段；count 支持已授权物理字段的非空值计数，其余方法仅支持数值字段。空集合 count 返回 0，其他方法返回 null。distinct 去重字段值，不是通过连接行去重根记录；仅接受数值、字符串、布尔、日期等支持标量，JSON 等在 SQL 前明确拒绝。

- [x] 在 `packages/module-tenant/src/server/__tests__/access-control/reads.test.ts` 增加内部统计用例，运行确认缺少方法导致失败。覆盖方法结果、NULL/重复值、根记录去重、角色/G/V/请求相交、实际关联筛选与隐藏授权事实、字段权限、恶意参数、快照、事务、元数据、共享表及查询数量。
- [x] 在 `access-control/reads.ts` 增加 `AccessAggregateRequest` 和 `aggregate`，复用现有根读取计划，严格捕获方法/字段/distinct；count 显式指定整数结果类型。旧 count/sum 保持契约；补齐内置 double 的实际数值类型键，修复旧 sum 对合法双精度字段的误拒。
- [x] 在 `access-control/entry-reads.ts` 增加 aggregate 操作权限和内部入口，继续使用最终 ACL 及路径授权快照。不接受请求提供的 SQL、group、dataType、授权或输出展开。
- [x] SQLite 与随机独立 PostgreSQL 库执行根读取及关联汇总回归，运行严格类型、lint、格式和租户包构建；独立审查后更新设计进度，签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t numeric.aggregate --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。

## 验证记录

- 首轮 19 项 SQLite 新测试因缺少 aggregate 方法失败。实现后发现整数字段平均值被截断，再由实际 PostgreSQL 测试确认数值字符串没有转换：ORM 只对具体 FLOAT/DECIMAL 类型解析浮点结果，类型名称字符串不会被实例化。最终使用 `DataTypes.FLOAT` / `DataTypes.INTEGER`，并检查实际返回值类型。
- 独立审查发现 JSON 去重及 double 类型键边界。新增 JSON 用例双库红灯确认：SQLite 错误放行，PostgreSQL 因 JSON 不支持等于操作符报错；现提前拒绝非标量 distinct。5 项内置 double 测试先红灯确认 `DOUBLE PRECISION` 被漏掉，补齐后也验证旧 sum 正常读取合法 double 字段。
- 三文件 SQLite / 随机独立 PostgreSQL 联合回归最初执行 656 项，655 项通过，唯一失败是上述 PG 平均值类型。修正后根读取文件完整双库回归 300 项全部通过（194.13 秒），包含新增 double、JSON 边界以及既有列表、详情、角色条件、日期、事务和汇总行为。
- 最后将结果空值分支单独返回，使包构建的非严格空值检查也能正确收窄 unknown；与原运行逻辑等价。调整后再次双库聚焦验证 56 项全部通过（48.93 秒）。所有本阶段随机专用 PostgreSQL 库均已删除并确认不存在。
- 最终严格 TypeScript 0 项诊断、oxlint 0 错误/警告、Prettier 和差异检查、租户包构建通过。独立审查问题均已修正，最终无待修问题；审查者独立 SQLite 验证 28 项通过。
- 仍是未注册的内部基础；未修改核心、依赖、业务配置或业务数据库，未启用业务页面。
