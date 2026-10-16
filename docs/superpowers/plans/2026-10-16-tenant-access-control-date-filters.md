# 日期筛选适配计划

使用 writing-plans、executing-plans 和测试驱动流程，继续已批准的访问控制设计。本阶段仅扩展内部筛选契约，不启用业务表。

## 契约与文件

- 新建 `packages/module-tenant/src/server/access-control/date-filter.ts`：校验七种核心日期运算符的绝对日期操作数，并固定隐式时区。接受年、月、日、小时、分钟、秒、毫秒、UTC 时间点及核心区间语法；拒绝不存在的日期、未解析变量、季度/周及其他未适配输入。
- 修改 `access-control/request-filter.ts`：在已授权的 DATE/DATEONLY 物理字段上允许日期运算符，先校验操作数再交给核心 `FilterParser`。根、关联和角色事实条件复用同一解析链；普通字段运算符不改变。
- 新建 `__tests__/access-control/date-filter.test.ts`，修改 `__tests__/access-control/reads.test.ts`：验证核心语义对照、日期边界、NULL、G/V、角色交集、关联、分页计数合计、输入错误及异步查询前的值快照。

隐式时区在一次 parse 开始时捕获，不读取请求提供的 SQL、授权或任意上下文。核心字符串日期采用数据库配置时区，数组区间没有第四项时使用 UTC；保留这个既有差异，入口解析后的数组应明确提供第四项。输入显式偏移优先。相对日期模板必须在调用前解析，解析器不自行读时钟或查询用户变量。区间边界继续使用核心实际查询规则，不修改核心行为。

## 步骤

- [x] 先增加真实读取的日期当天测试，确认旧实现以“不支持操作符”失败。
- [x] 实现绝对日期校验与时区快照，七种运算符只用于真实日期字段，沿用核心生成谓词。
- [x] 补齐核心对照与权限、关联、聚合、时区、坏输入回归。
- [x] SQLite / 独立 PostgreSQL 回归、严格类型、lint、格式、租户包构建和独立审查。
- [x] 更新设计进度和验证记录，以签名原子提交交付。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/date-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/read-grants.test.ts packages/module-tenant/src/server/__tests__/access-control/role-filter.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot`。PostgreSQL 仅使用随机独立本地测试库。

## 实施说明

独立审查发现核心将同字段的日期谓词合并时可能覆盖同名 ORM 符号，例如 `$dateOn` 与 `$dateBetween` 的 `Op.and`。本适配层对含日期运算符的多个条件逐项调用核心，再以外层 AND 取交集，不修改核心或普通字段筛选。回归覆盖互斥区间、属性顺序颠倒、角色条件、日期与普通运算符组合。

接受年份为 1000—9999，偏移为 ±14:00 以内的有效 UTC 偏移；日期区间上下界沿用核心的实际谓词语义，包括 UTC 时间点区间的既有边界行为。DATEONLY 使用注册物理日期字段与核心真实查询对照。相对日期、季度/周、时区名称、业务路由均未在本阶段启用。

## 验证结果

2026-10-16：日期操作数、请求筛选、最终权限转换、角色事实条件、根读取及关联展开共六个测试文件，SQLite / 独立 PostgreSQL 合计 677 项全部通过，测试库已删除。严格 TypeScript 0 诊断，oxlint 0 错误和警告，Prettier 检查及 `tegod build @tachybase/module-tenant` 通过。独立审查复核混合条件修正后无新增问题，并完成 146 组核心谓词对照与 DATEONLY 查询检查。未修改核心仓库或业务数据配置。
