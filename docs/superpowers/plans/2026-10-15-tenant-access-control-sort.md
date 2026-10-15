# 可读范围内的单值关联排序

沿用已确认的归属性 G、可见性 V 设计，在内部查询层补齐排序。继续使用现有功能分支，不注册业务入口、不改变生产或本地业务数据。

## 范围与契约

- 新增 `server/access-control/sort.ts`，提供 `AccessSortService.scopeRoots`。服务端传入读取授权 resolver，用户仅提供 `name`、`-amount`、`project.company.name` 形式的排序字段列表。
- 根记录、每跳目标分别检查 G/V 和既有角色读取范围；来源关联字段、目标关联字段及最终物理字段必须得到明确授权。
- 先支持根物理标量字段和最多 3 跳 BelongsTo。HasOne、HasMany、多对多、自关联、JSON/数组、虚拟字段、表达式和自定义方向均明确拒绝，不擅自选择任一目标。
- 不可读、默认范围排除、软删除、缺失或空外键目标统一按 NULL 排序。升降序均将 NULL 放在末尾，并以根主键作为内部稳定次序，避免分页重叠。
- 使用相关标量子查询，不将排序目标连接进根 FROM，不扩增根记录。列表使用 `query`；计数和根金额汇总使用同一根谓词的 `rootQuery`，排除仅排序引用的目标参数，避免 SQLite 拒绝未使用的绑定。
- `sourceWhere`、`sourceBind` 仅接收服务端已解析条件，可组合上一阶段筛选树计划。命名绑定相同值可复用，冲突拒绝。执行前后必须调用 `assertCurrent()`。
- 首次 await 前快照排序、身份、授权谓词与关系元数据。配置阶段、模型、字段或关系发生变化时拒绝发布计划。

## 实施与验收

文件：新增上述服务、`server/__tests__/access-control/sort.test.ts`；在总设计文档记录进度。

- [x] 先编写 SQLite/PostgreSQL 行为测试并确认缺少服务时失败。
- [x] 实现有界输入解析、授权链快照和数据库排序计划。
- [x] 验证根字段、深层排序、隐藏目标不影响次序、G/V 与角色范围、共享目标、默认 scope、关联 scope、软删除、分页及计数/金额。
- [x] 验证 SQL 次数不随 20/100 条结果增长；验证未知字段、非法路径、访问器、授权缺失、绑定冲突及元数据变化被拒绝。
- [x] 运行排序与请求筛选聚焦双库回归、严格类型、lint、格式及租户包构建；独立审查后签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/sort.test.ts packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 仅使用随机命名的本地专用测试库，退出后删除并确认；不得使用业务库。

此阶段仍是内部服务。业务入口 ACL 解析、日期及扩展筛选、其余关联排序、未迁移表兼容、配置页面和真实业务性能验收仍需继续完成。

验证记录（2026-10-15）：SQLite/PostgreSQL 排序及请求筛选共 58 项通过，随机专用 PostgreSQL 测试库已删除并确认。20/100 条结果的 SQL 次数一致，生成的根查询没有关联 JOIN。严格 TypeScript 检查为 0 诊断；oxlint、Prettier、`pnpm exec tegod build @tachybase/module-tenant` 通过。独立只读审查无具体缺陷。首轮验证发现排序专用参数被带进计数后 SQLite 报 `SQLITE_RANGE`，已通过独立 `rootQuery` 修复，并用真实参数、计数和金额回归覆盖。
