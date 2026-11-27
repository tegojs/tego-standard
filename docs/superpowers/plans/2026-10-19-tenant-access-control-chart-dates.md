# 图表日期分组实施计划

**目标：** 内部图表支持根日期字段按 `YYYY`、`YYYY-MM`、`YYYY-MM-DD` 汇总，继续应用角色权限 ∩（G ∪ V）∩ 请求条件。

**设计：** 保留原字符串分组字段；新增内部 `{ field, format, timezone }` 分组描述符。只接受三个日期格式和明确 UTC 偏移。图表适配从独立的服务端日期上下文取得时区，与现有图表使用请求时区的约定一致；实际 DATE 时间按该偏移换算，DATEONLY 不换算。客户端 type 提示不参与判断。不改变现有过滤器的字段时区规则。

**文件职责：** `aggregate-groups.ts` 捕获分组描述符并生成受限日期表达式；`reads.ts` 校验实际字段类型、生成 SELECT/GROUP BY/ORDER BY 并读取格式化字符串；`chart-params.ts` 保留允许的格式；`entry-reads.ts` 传入独立日期上下文。仅 SQLite/PostgreSQL，其他数据库明确拒绝格式化分组。原始分组和单统计项返回结构保持兼容。

- [x] 在 `reads.test.ts` 增加失败用例：正负偏移跨日/月/年、纯日期、NULL、多维多统计、排序、组上限、权限与关联筛选、事务、输入快照及无效描述符。
- [x] 运行 SQLite 日期聚焦测试，确认因尚未支持格式化分组失败。
- [x] 实现捕获、类型校验及共用 SQL 表达式，格式化键使用服务端别名，避免 ORM 把结果重新解析成 Date。
- [x] 运行随机专用 PostgreSQL/SQLite 图表测试及完整根读取回归；严格类型、lint、格式、租户包构建；独立审查后签名原子提交。

验证命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t chart.params --maxWorkers=1 --pool=threads --no-file-parallelism`、`node .tmp/tenant-access-verify.cjs --numeric-aggregate-roots`、`node .tmp/tenant-sort-types.cjs`、`pnpm exec tegod build @tachybase/module-tenant`。

边界：继续限制为最多三个互不重复根字段、十个统计项、最多 1000 组；不接受任意 SQL、客户端时区或关联日期维度；不安装真实图表入口，不修改核心、依赖和业务配置。

## 验证记录

- 首轮 SQLite 日期分组 7 项因尚未支持格式化而失败；实现后 8 项通过，补齐事务、描述符快照、查询次数及生命周期验证后 13 项通过。
- SQLite/PostgreSQL 图表聚焦 88 项通过（30.67 秒）；最终全部根读取 440 项通过（133.81 秒），包含日期分组及原始分组、标量、多项统计和列表详情回归。专用随机 PostgreSQL 库均已删除并确认不存在。
- 严格 TypeScript 0 项诊断；oxlint 0 项错误和警告；Prettier、差异检查和租户包构建通过。
- 独立审查未发现阻断项；审查者另运行 SQLite 日期分组 13 项及原分组聚合 18 项，全部通过。核心、依赖、业务配置和业务数据未修改。
