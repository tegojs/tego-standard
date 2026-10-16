# 周与季度日期筛选实现计划

沿用已批准的租户访问控制设计，使用 writing-plans / executing-plans、测试驱动和独立审查完成这一批。

**目标：** 内部读取入口支持核心的季度、普通周及 ISO 周条件，保持角色权限、G/V、字段权限和原有日期行为。

**实现范围：** `date-filter.ts` 只新增有界日历标签校验。接受 `YYYYQ1` 至 `YYYYQ4`、`YYYYw01` / `YYYYW01` 至实际存在的末周，年份仍为 1000–9999，偏移仍由现有校验器检查。普通周与 ISO 周分别沿用核心约定，不把两种周混为一种。第 53 周使用核心 `getDateVars` 检查该周是否实际存在；只扫描该年的最后 7 个日期，使用固定 UTC 时间，不依赖当前时钟、不自行实现相对日期算法。实际范围仍由核心 `FilterParser` 转换。

## 文件

- 修改 `packages/module-tenant/src/server/access-control/date-filter.ts`：在普通日历日期之前识别并校验上述标签；区间端点复用同一校验，不增加依赖。
- 修改 `packages/module-tenant/src/server/__tests__/access-control/date-filter.test.ts`：绝对标签、混合区间与 7 种运算符核心对照，以及错误季度、周号、年份、时区及不存在的第 53 周。
- 修改 `packages/module-tenant/src/server/__tests__/access-control/read-date-filter.test.ts`：将 9 个周/季度快捷值加入既有核心对照；覆盖固定时钟、跨年、GMT、普通周和 ISO 周区分。
- 修改 `packages/module-tenant/src/server/__tests__/access-control/reads.test.ts`：SQLite / PostgreSQL 验证周边界、季度边界、分页和计数、关联与最终角色条件，并确认坏标签在 SQL 前拒绝。
- 更新设计进度和本计划的验证记录；本批不注册业务路由、不修改核心或业务配置。

## 执行步骤

- [x] 先新增 `2026Q3+08:00`、`2026W38+08:00`、`2026w38+08:00` 的核心谓词对照，运行确认旧解析器因尚不支持标签失败。
- [x] 增加标签校验，保留核心解析和旧字符串/数组时区契约；移除测试中对合法周/季度的旧拒绝断言，保留坏输入拒绝。
- [x] 将 `this/last/nextWeek`、`this/last/nextIsoWeek`、`this/last/nextQuarter` 加入快捷值验证，确认 `$dateBetween` 仍扩展完整单位。
- [x] 真实数据库断言：核心默认 locale 下普通周星期日开始，ISO 周星期一开始；普通周始终沿用核心当前 locale，不能统一解释成 ISO 周。季度包含完整首尾边界。列表/详情/分页/计数只返回各自角色及 G/V 允许项；关联目标独立受限。
- [x] 运行聚焦测试、严格 TypeScript、oxlint、Prettier 和租户包构建；完成独立审查。

## 验证结果

- 3 个标签回归测试在旧实现下均因 `Date filter value is unsupported or unresolved` 失败；实现后通过。
- 日期绝对值、快捷变量、请求筛选、最终角色条件及根读取共 5 个文件：SQLite / 随机独立 PostgreSQL 共 449 项测试通过（188.26 秒）。专用测试库已删除并确认不存在，未触碰业务库。
- 严格 TypeScript：0 项诊断；4 个代码文件 oxlint：0 错误、0 警告；Prettier 检查通过；租户包构建通过。
- 独立审查无待修问题。额外验证 400 年周期、3 种 locale 的 12,000 个周年份及第 53 周样本，以及 3,108 组核心谓词；核心语义一致，检查次数有界。新增真实查询测试经独立审查，未发现假通过或数据相互污染。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/date-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/read-date-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot`。PostgreSQL 使用随机独立本地测试库，完成后删除并核实。
