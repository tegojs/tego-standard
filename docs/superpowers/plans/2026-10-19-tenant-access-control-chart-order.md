# 图表分组排序实施计划

**目标：** 内部图表适配支持按已选择的分组字段或统计值排序，复用统一授权后的 SQL 分组查询。

**架构：** `chart-params.ts` 将现有 `orders` 的字段/别名解析为明确的分组字段或统计值；`aggregate-order.ts` 捕获并严格验证内部排序描述。`reads.ts` 只允许已授权的分组字段或本次统计值参与排序，数据库执行排序，所有方向 NULL 最后；没有显式指定的组键自动升序补齐，使同值结果稳定。输出别名不进入 SQL。

**边界：** 单统计项、最多三个维度；最多四个不重复排序项。`order` 缺省升序，接受 `asc/desc/ASC/DESC`。`field` 接受字符串或单元素数组，定位已选字段或输出别名；显式 alias 必须存在，若同时传 field 则两者必须一致。歧义、未知字段、SQL、关联路径、getter、稀疏数组及额外选项全部拒绝。无维度时验证排序后仍返回唯一统计行。组数上限继续是完整结果保护，超限整体拒绝，不将 limit 偷换为前 N 组。

- [x] 在 `reads.test.ts` 增加失败测试：排序五种统计、组字段、复合优先级、NULL、同值补齐、字段权限、别名与特殊字符、标量、输入快照、超限和无效形状 SQL 前拒绝。
- [x] 创建 `access-control/aggregate-order.ts`，在权限回调前捕获内部排序；扩展 `AccessGroupedAggregateRequest.order` 并编译经过验证的 SQL 排序。
- [x] 扩展 `chart-params.ts` 和 `entry-reads.ts`，将选中项排序转换并传入分组读取，不改变现有图表插件或业务行为。
- [x] 运行 SQLite 红绿验证、随机专用 PostgreSQL/SQLite 图表及根读取回归、严格类型、lint、格式和租户包构建；独立审查后更新设计进度，签名原子提交。

验证：`node .tmp/tenant-access-verify.cjs --chart-focused`、`node .tmp/tenant-access-verify.cjs --numeric-aggregate-roots`、`node .tmp/tenant-sort-types.cjs`、`pnpm exec tegod build @tachybase/module-tenant`。仅随机专用测试库，不能连接业务库；核心仓库只读。

## 验证记录

- SQLite 红灯：8 项图表排序用例因非空 orders 被拒绝失败，2 项分组排序用例因不接受 order 失败。实现后双库首轮图表聚焦 50 项通过。
- 根读取完整双库回归 386 项通过（103.55 秒）。随后补充四项排序、显式 alias 消歧及无效排序形状；最终双库图表聚焦 52 项通过（16.08 秒）、分组聚焦 36 项通过（17.78 秒）。随机专用 PostgreSQL 测试库均已删除并确认不存在。
- 严格 TypeScript 0 项诊断、oxlint 0 项错误/警告、Prettier、差异检查和租户包构建通过。独立代码审查未发现阻断项。
- 未修改核心、依赖、业务数据库或配置，未接入真实图表插件执行路径；本批交付内部排序能力。
