# 图表统计参数适配实施计划

**目标：** 把现有图表的单统计项和根字段分组转换为统一租户统计请求，输出图表使用的平面别名记录。

**架构：** 仅新增未注册的内部 `chartFromParams`。可信调用者分别提供表身份、当前身份、事务和日期上下文；图表参数不能改变这些值。沿用图表既有的列表权限，复用 `AccessReadService.aggregate/groupAggregate`，不复制 G/V、角色或关系筛选逻辑。

**边界：** 接受一个带明确 `avg/count/min/max/sum` 的根物理字段统计项，零至三个根标量分组字段，及 `filter`、空 `orders`、1–1000 的 `limit`。字段支持字符串和单元素数组；输出别名使用显式 alias 或字段名，别名不能重复。允许描述性 type 和空 format，但不据此推断字段权限或类型。关联字段、多统计项、日期格式化、排序、SQL 和额外请求参数明确拒绝。路由、缓存、数据源与表选择由将来的真实图表入口单独处理，本阶段不改图表插件的现有执行路径。

- [x] 在 `reads.test.ts` 增加失败测试：平面别名、五方法、分组、分数平均值、空集合、独立列表权限与字段限制、关联筛选、可信日期及事务、输入快照、组数上限和无效参数在 SQL 前拒绝。
- [x] 新增 `access-control/chart-params.ts`，同步验证普通数据属性和有界稠密数组，复制字段、别名及筛选，不执行 getter；拒绝未支持协议。
- [x] 在 `entry-reads.ts` 增加 `chartFromParams`，使用 list 操作解析角色权限，委托现有标量或分组服务并映射平面别名。只输出授权统计结果，不输出内部组键包装。
- [x] SQLite / 独立随机 PostgreSQL 聚焦测试和根读取回归通过；类型、lint、格式、租户包构建及独立审查通过，更新设计进度并签名原子提交。

验证命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t chart.params --reporter=default --maxWorkers=1 --pool=threads --no-file-parallelism`；双库使用已有随机专用测试库脚本，不能连接业务库。

## 验证记录

- 首轮 SQLite 新测试 15 项因缺少 `chartFromParams` 失败；实现后 SQLite 15 项、双库聚焦 30 项均通过（双库 16.68 秒）。随后补充特殊输出别名及稀疏数组等边界，图表用例增为每库 16 项。
- 根读取文件完整 SQLite / 随机专用 PostgreSQL 回归 364 项通过（106.03 秒），包括全部图表用例及原有列表、详情、筛选、分组和标量统计。所有专用 PostgreSQL 测试库已删除并确认不存在。
- 严格 TypeScript 0 项诊断、oxlint 0 错误/警告、Prettier、差异检查及租户包构建通过。独立静态审查无阻断项，审查者另运行 SQLite 图表聚焦测试 15 项通过。
- 未修改核心、依赖、图表插件、业务配置或业务数据库；当前是可供真实图表入口调用的内部子集，并非已完成业务图表接入。
