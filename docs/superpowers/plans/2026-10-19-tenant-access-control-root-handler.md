# 普通资源读取处理器

目标：将核心 ACL 完成后的普通 `list/get/count` 动作接到统一读取器，保持核心响应格式。本阶段只提供内部处理器，不注册路由，不启用业务，不改核心或依赖。

处理器分别捕获可信身份、最终 `parsedParams` 权限和合并前 `rawParams` 请求。原始参数中的资源、动作及 REST 定位元数据必须与实际动作一致；只移除已校验的协议字段和核心的未定义定位占位。缺少原始请求不得回退到合并参数。根读取权限仅用于根表，关联字段的用户查询或展开在缺少独立最终授权时拒绝，角色内部关联事实仍按既有编译器计算。

- [x] 先写测试并确认失败：真实核心 ACL 合并、列表分页、详情、计数、拒绝、非法协议、快照与响应不变。
- [x] 实现最小处理器，校验配置数据库、资源动作、角色绑定；成功且生命周期校验完成后才写响应。
- [x] SQLite/PostgreSQL 根读取回归、最终权限单测、严格类型、lint、格式及租户包构建。
- [x] 独立审查并签名原子提交。

验证：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t root.handler --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`；`node .tmp/tenant-access-verify.cjs --numeric-aggregate-roots`；`node .tmp/tenant-sort-types.cjs`；`pnpm exec tegod build @tachybase/module-tenant`。只使用隔离测试数据库。

2026-10-19 验证记录：空处理器下 32 项新测试失败，实现后 SQLite 聚焦 32 项通过；使用真实核心 Resourcer Action 与 ACL 中间件。SQLite/PostgreSQL 完整根读取回归 526 项通过（193.77 秒），专用测试库清理完成；最终权限单测 19 项通过，严格 TypeScript 0 诊断，oxlint 0 错误或警告，Prettier、diff 检查及租户包构建通过。独立审查对照安装核心 1.6.24 未发现阻断项，另外运行 SQLite 聚焦 32 项通过。首次双库进程曾无断言信息异常退出，其测试库也正常清理；单独完整重跑通过，未为此修改依赖或放宽断言。
