# 最终读取权限捕获计划

**目标：** 将现有核心 ACL 中间件完成后的服务端权限转换成内部读取权限，供图表和后续资源入口使用，不注册新路由。

**边界：** 只接受可信处理器拿到的 `ctx.permission`，不得传入请求参数。核对服务端指定的资源、动作及角色；仅使用 `parsedParams`，绝不从已合并用户筛选的 `action.params`、`rawParams` 或 `mergedParams` 推导授权。无操作授权返回拒绝；有授权但未完成参数解析必须报错。保留核心明确的 `skip` 操作授权，同时仍由读取器执行 G/V。集合身份、关联各跳授权和规则版本仍由现有读取服务负责。

**文件：** 新增 `access-control/final-read-permission.ts` 和对应测试；在 `reads.test.ts` 用真实 ACL 中间件验证图表读取；更新设计进度。核心及依赖不变，当前安装核心尚无范围委托扩展点，本轮不尝试启用或替代它。

- [x] 先写失败测试：操作拒绝、未完成参数解析、资源/角色/动作不匹配、快照及 getter 防护、忽略请求合并参数；运行确认缺少捕获函数。
- [x] 实现最小捕获函数，校验可信绑定和原始描述符，复制最终参数；不执行第二套 ACL 判断，不解析变量。
- [x] 真实核心 ACL 中间件验证别名、固定范围、角色变量、字段限制、拒绝及显式 skip；图表与 G/V 相交，不读取隐藏的角色事实字段。
- [x] 聚焦测试、双库根读取、类型检查、lint、格式及租户包构建；独立审查。

验证命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/final-read-permission.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`；`node .tmp/tenant-access-verify.cjs --numeric-aggregate-roots`；`node .tmp/tenant-sort-types.cjs`；`pnpm exec tegod build @tachybase/module-tenant`。数据库仅使用隔离 SQLite 和随机专用本地 PostgreSQL。

2026-10-19 验证记录：测试最初因缺少捕获模块而无法加载；实现后捕获单元测试通过 19 项，SQLite 核心相关聚焦测试通过 6 项（含新增 3 项）。SQLite/PostgreSQL 根读取完整回归通过 462 项（152.49 秒），随机专用测试库已删除。包含新增单元文件的严格类型检查 0 诊断，改动代码 oxlint 无错误或警告，Prettier、diff 检查及租户包构建通过。独立审查对照安装版核心契约未发现阻断项，并另外通过当时的 17 项单元测试；之后仅补充 2 项边界测试及嵌套 getter 断言，生产实现未变。
