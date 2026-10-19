# 图表完整请求适配实施计划

**目标：** 将图表请求中的数据源、表及查询参数安全接入现有内部统计能力，不注册真实业务路由。

**架构：** `chart-query-params.ts` 捕获完整请求，校验 `uid/cache/refresh` 并委托 `parseChartParams` 捕获统计参数；`AccessEntryReadService.chartFromQuery` 复用资源路由的集合身份与生命周期校验，要求请求数据源与服务端实际表身份完全一致，再调用共用的图表执行器。可信用户、租户、角色、事务和日期仍独立传入。`read-date-filter.ts` 提取已有日期上下文校验为快照函数，在元数据回调前固定时钟和时区。

**缓存约定：** 接受现有 `cache.enabled/ttl`、`refresh` 和 `uid`，只校验、不读写缓存。两次相同请求都重新执行本次权限及数据查询；不使用旧图表缓存键。日后启用缓存必须另外验证身份、角色、规则版本、关系变化及日期变量失效。当前未安装中间件，现有图表插件及其缓存行为不变。

**输入边界：** `collection` 必填且只能是根表名，`dataSource` 缺省为 `main`。只接受现有图表查询与元数据字段，不接受 SQL、客户端身份、事务、服务端日期上下文或底层查询选项。`uid` 最多 255 字符；缓存 ttl 是非负有限秒数且毫秒值不超安全整数；refresh/enabled 是布尔值。统计规模、别名、日期格式与组数上限沿用上一阶段。

- [x] 在 `reads.test.ts` 增加失败测试：完整请求、多统计及日期、缺省数据源、数据源/表不匹配、相同请求重新授权/读取、元数据回调前快照、集合身份漂移、可信事务、非法字段与 getter。
- [x] 运行 SQLite `-t chart.query`，确认因缺少入口失败。
- [x] 实现严格参数捕获、日期上下文快照和共用图表执行器；复用现有根集合路由校验，无数据库或核心新增依赖。
- [x] 双库根读取及日期解析回归、严格类型、lint、格式、租户包构建、独立审查。

验证：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t chart.query --maxWorkers=1 --pool=threads --no-file-parallelism`；`node .tmp/tenant-access-verify.cjs --numeric-aggregate-roots`；`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/read-date-filter.test.ts`；`node .tmp/tenant-sort-types.cjs`；`pnpm exec tegod build @tachybase/module-tenant`。仅使用 SQLite 和随机专用本地 PostgreSQL 测试库。

2026-10-19 验证记录：新增用例先因缺少 `chartFromQuery` 失败 8 项，实现后 SQLite 通过 8 项。SQLite/PostgreSQL 根读取完整回归通过 456 项（152.59 秒），随机专用 PostgreSQL 测试库已删除；日期解析及资源路由回归通过 117 项。严格类型检查 0 诊断，改动文件 oxlint 无错误或警告，Prettier、diff 检查及租户包构建通过。独立审查未发现阻断问题，并另外通过 SQLite 图表请求 8 项、日期解析 56 项。本轮不注册业务入口、不修改核心、依赖或业务配置。
