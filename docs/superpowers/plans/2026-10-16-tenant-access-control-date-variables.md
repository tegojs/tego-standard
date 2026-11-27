# 页面日期变量适配计划

使用 writing-plans / executing-plans 继续已批准的租户访问控制设计；采用测试驱动，完成后独立审查并签名原子提交。

**目标：** 将页面“今天、本月、最近 7 天”等快捷日期转换为绝对条件，再沿用现有角色、G/V 和请求交集。

**架构：** 时间与时区作为独立的可信服务端参数传入，不从请求参数读取。复用核心 `getDateVars` 计算日、月、年及滚动天数；只识别日期运算符值中的完整 `$nDate` / 旧 `$date` 模板，不开放任意变量或脚本。日期和筛选均在首次异步操作前捕获。

## 文件与契约

- `access-control/filter-input.ts`：从请求解析器提取既有严格 JSON 快照，不改变节点、深度、数组及描述符边界。
- `access-control/read-date-filter.ts`：新增 `AccessReadDateContext` 和 `resolveReadDateFilter`。上下文仅接受 `now`（有效 UTC 时间点）和 `timezone`（有效偏移）；递归保留逻辑组与关系路径，使用可信字段时区解析器支持 GMT 字段。绝对日期交给已有校验器，日期变量结果也必须通过该校验器。未知/不完整日期模板、用户/角色模板、周/季度快捷值明确拒绝；非日期字段文本不解析。
- `access-control/date-filter.ts`：导出既有 UTC 偏移校验以供可信上下文复用，不改变绝对日期语义。
- `access-control/request-filter.ts`：复用提取后的筛选快照。
- `access-control/entry-reads.ts`：`listFromParams`、`listPageFromParams`、`getFromParams` 增加事务之后的可选可信日期上下文；未传入时维持当前契约。解析后的筛选只作为用户条件，最终角色条件仍由既有入口协议独立解析。
- `__tests__/access-control/read-date-filter.test.ts` 及 `reads.test.ts`：核心对照、固定时间、跨日/月/年、字段 GMT、关联、逻辑组、权限、分页计数、输入及异步变更回归。

## 执行步骤

- [x] 在 `reads.test.ts` 增加固定 `now = 2026-09-16T00:00:00.000Z`、`timezone = +08:00`、`occurredAt.$dateOn = {{$nDate.today}}` 的页面读取测试，期望只有 Owned / Visible；运行确认旧实现拒绝未解析日期。
- [x] 提取严格 JSON 快照，编写日期上下文与模板解析器，接入三类页面参数读取方法；以核心 `getDateVars` 为唯一相对日期计算来源。
- [x] 单元测试以核心 `parseFilter` + `FilterParser` 对照日/月/年和滚动天数；周、季度、用户变量、原型/访问器/稀疏数组及错误上下文明确拒绝。UTC now 使用捕获值，不使用核心临时创建的当前时间；`dateBetween` 的单个日/月/年变量转换为同单位首尾区间。
- [x] 真实 SQLite / 独立 PostgreSQL 验证列表、详情、分页计数、关联日期及角色/G/V 交集；同时回归绝对日期和旧参数调用。
- [x] 严格类型、oxlint、Prettier、租户包构建、独立审查，更新设计进度和验证记录。

## 验证结果

- 首个固定日期页面测试在旧实现下报 `Date filter value is unsupported or unresolved`；接入后通过。
- SQLite / 随机独立 PostgreSQL：日期变量、绝对日期、请求筛选、最终读取权限、角色条件、根读取和关联展开共 7 个文件，742 项测试通过（351.42 秒）。测试库已删除并确认不存在；未使用业务库。
- 新增真实查询覆盖三类参数入口、分页行与总数、关联目标独立授权、逻辑组、GMT 字段、跨日、瞬时比较、异步输入变化，以及旧调用与数组区间的时区兼容。
- 严格 TypeScript：0 项诊断；7 个变更代码文件 oxlint：0 错误、0 警告；Prettier 检查通过；`pnpm exec tegod build @tachybase/module-tenant` 通过。
- 独立审查无待修问题；额外 4,995 组核心谓词对照一致，覆盖闰日、跨年、入口时区和字段时区。新增测试经独立审查，未发现假通过或数据相互污染。

聚焦验证：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/read-date-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/date-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot`。PostgreSQL 仅使用随机独立本地测试库。

这只是内部入口扩展，不注册业务路由，不修改线上或本地业务配置，不增加依赖。实际入口须传入经过服务端确认的日期上下文；授权身份继续独立取得。
