# 图表读取的最终权限组装

目标：在 `AccessRootReadHandler` 增加内部 `handleChartWithRelatedContexts`，把图表完整请求与现有最终集合 list 权限、关联权限准备和统一统计执行器接起来。继续执行已批准的归属性与可见性设计，不注册业务路由或更改生产配置。

调用者提供已经完成既有 ACL 授权链的集合 list 上下文。其原始参数必须为空（仅允许已校验的核心路由元数据），不能把带定位或请求筛选的授权用于任意统计。图表集合、数据源必须与已授权集合的实际身份一致。请求、身份、权限和日期在异步授权前捕获；缓存设置不能跳过实时授权或查询。

- [x] 在 `reads.test.ts` 的真实核心 ACL 夹具中补充失败用例：标量/分组统计、关联筛选、角色字段和固定范围、错误绑定、缺权、异步输入变化、事务和日期、配置失效、缓存重新读取。
- [x] 运行聚焦测试确认缺少新方法；在 `root-read-handler.ts` 实现，提取并复用现有请求级准备和读取服务构造，避免维护第二套授权链。
- [x] 运行 SQLite 与独立 PostgreSQL 聚焦及读取回归、严格类型、lint、格式和租户包构建；独立审查未发现需要修复的问题。

验证命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts -t 'chart handler' --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`；双库使用现有本地隔离测试库脚本。无维度返回一行统计，有维度返回平面分组结果；失败不替换响应，不设置分页标志。关联统计字段等未支持形状仍由原有图表解析器拒绝。

结果：新增 12 项 SQLite 测试先因方法缺失失败，再全部通过；`reads`、`related-read-contexts`、`final-read-permission`、`resource-read-routing` 双库四文件共 808 项通过。严格 TypeScript 诊断为 0，修改代码的 oxlint 和 Prettier 检查、`pnpm exec tegod build @tachybase/module-tenant` 均通过。独立 PostgreSQL 测试库已删除，业务数据未改变。
