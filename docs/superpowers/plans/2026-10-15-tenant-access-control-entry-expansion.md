# 单值关联展开的入口权限接入计划

> 沿用已批准设计，在 `feat/tenant-access-control` 使用 executing-plans、测试驱动与独立审查完成本阶段。

**目标：** 把已完成变量解析的角色权限接入 BelongsTo 批量展开，来源可读、关联字段和目标输出字段有授权时，才允许展开；不可读目标返回 `null`，可读来源保留。

**架构：** 在 `AccessEntryReadService` 增加 `expandBelongsTo`，沿用每次操作独立的权限转换与角色条件编译。请求只接收关联名称、有限来源主键、明确目标字段和事务；来源、目标身份由登记模型与可信解析器取得。来源及目标分别执行自己的角色条件和 G/V，不接受调用方传入原始 SQL 条件。复用现有 `AccessBelongsToExpansionService`，增加可选生命周期检查，覆盖首次异步调用前及来源/目标查询前后。

**文件：**

- 修改 `packages/module-tenant/src/server/access-control/entry-reads.ts`：复用操作内 grant/check 组合，增加单跳单值展开入口，不自动映射 ACL 动作。
- 修改 `packages/module-tenant/src/server/access-control/belongs-to-expansion.ts`：保留原有契约，仅增加内部可选授权检查。
- 修改 `packages/module-tenant/src/server/__tests__/access-control/belongs-to-expansion.test.ts`：在既有真实双库样例中验证角色权限组合、字段限制、关联事实、生命周期、并发与固定查询次数。
- 更新设计进度和本计划验证记录。

## 步骤与验收

- [x] 先写失败测试：展开 `[1,2,3,4,5,6]` 的结果保留六个来源，隐藏、空及不存在目标为 `null`；来源和目标分别受角色数据条件约束，授权事实不输出。
- [x] 实现 `expandBelongsTo(ctx, source, authenticated, { association, sourceKeys, targetAttributes, transaction })`。根、目标操作拒绝或字段未授权时，在 SQL 前拒绝；请求访问器、原始条件、坏数组及 `/_/` 明确拒绝。
- [x] 验证权限及请求在首次 await 前快照；角色事实元数据在来源/目标查询期间变化后拒绝返回，并发与重复调用互不干扰。验证共享目标、同表关联、历史数据、事务及 20/100 条查询次数。
- [x] 运行 belongs-to-expansion、reads、read-grants、role-filter 的 SQLite/PostgreSQL 聚焦测试；严格类型、oxlint、Prettier 与租户包构建通过，专用 PostgreSQL 库删除并确认。
- [x] 独立审查无阻塞问题，更新设计与验证记录；本阶段作为单独的签名提交保存。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/belongs-to-expansion.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/read-grants.test.ts packages/module-tenant/src/server/__tests__/access-control/role-filter.test.ts --reporter=default --maxWorkers=1 --pool=threads --no-file-parallelism`。

本阶段只提供内部单跳展开契约；不启用业务页面、不登记资源、不自动组装嵌套 appends，不修改生产或业务数据。无目标操作/字段授权属于不支持的请求，整体拒绝；已授权目标中不匹配角色行范围或 G/V 的记录按隐藏目标返回 `null`。

输出边界：用 10050 项的已授权 JSON 字段实际复现旧展开服务误套输入大小限制而报错，调整为直接投影本次数据库读取的原始字段值，与根读取一致；仍省略 getter、未选字段与内部配对键。此处只改变输出，不放宽请求或权限输入校验。

## 验证记录

- SQLite/PostgreSQL 四组测试共 416 项全部通过，其中单值展开 146 项；专用本地测试库已删除并确认。
- 严格 TypeScript 检查 0 个诊断，三个变更代码文件的 oxlint 与 Prettier 检查通过，`pnpm exec tegod build @tachybase/module-tenant` 成功。
- 独立审查覆盖来源/目标授权、字段投影、权限快照、元数据复核及固定查询次数，无阻塞问题。
- 前两次默认进程池运行异常中断，其中一次报告 `ERR_IPC_CHANNEL_CLOSED`，原因未确定；两次专用测试库均已清理。改用 `--pool=threads` 后，完整测试退出码为 0。未修改项目依赖或业务数据。
