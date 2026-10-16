# 根资源与关联占位符读取适配计划

沿用已批准的设计，使用执行计划、测试驱动和独立审查完成本批。

**目标：** 内部入口识别核心已解析的根资源和 `sourceId: '_'` 关联目标读取，将请求交给现有统一读取链。

**协议：** 核心 `getRepositoryFromParams` 对 `/_/` 的 get/list 直接选择目标 Repository，不查询来源记录，不限制已有连接，也不应用关联自身 scope。占位符只能用于关联 get/list，不能当作主键传给 SQL；根资源可执行已有 list/get/count/sum。具体来源 ID 的关联读取需要来源、目标和中间表授权，尚未接入时明确拒绝，不能错误降级成全部目标查询。

## 文件与步骤

- [x] 新增 `resource-read-routing.ts`，严格捕获 `resourceName` / `sourceId` / `actionName`；仅接受根名称或一层关联名，查找真实注册模型、关联和稳定目标身份。元数据和身份在查询前后复核。
- [x] `entry-reads.ts` 增加内部 `fromResource`，复用已有列表分页、详情目标键、计数和内部求和参数入口。身份、事务和日期上下文由服务端独立传入，响应仍由调用者包装。
- [x] 新增路由单测及根读取集成用例，先确认缺少实现失败。覆盖四类关系、共享/隔离目标、目标角色和字段权限、隐藏来源、日期、非法路径/操作/访问器、稳定身份及异步替换；不扩大具体来源关联读取支持范围。
- [x] SQLite / 独立 PostgreSQL、严格类型、lint、格式、包构建及独立审查；更新设计进度并签名原子提交。

## 验证记录

- 红灯：8 项根/关联目标路由因尚未实现失败，1 项真实读取因缺少 `fromResource` 失败；实现后通过。
- 路由、参数和根读取共 3 个文件，SQLite / 随机独立 PostgreSQL 共 374 项通过（164.49 秒）。加强非法路径用例后，40 项路由单测复核通过（6.78 秒）。测试库 `tego_tenant_access_test_b9bf93293b` 已删除并确认不存在，未改业务库。
- 严格 TypeScript：0 项诊断；4 个代码文件 oxlint：0 错误、0 警告；Prettier 和租户包构建通过。
- 独立审查无待修问题，核对核心占位符协议、四类目标选择、角色/字段/G/V、可信上下文与事务、稳定身份和异步替换；额外 21 项隔离脚本检查通过。路由解析不发 SQL，现有查询链不变。

调用者提取描述符，例如 `{ resourceName: ctx.action.resourceName, sourceId: ctx.action.sourceId, actionName: ctx.action.actionName }`，与已经解析的 `ctx.action.params` 分开传入；不直接传整个 Action 实例。最终权限仍由可信回调按原请求上下文解析。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/resource-read-routing.test.ts packages/module-tenant/src/server/__tests__/access-control/resource-read-params.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。PostgreSQL 使用随机独立本地测试库。

仍不注册实际资源路由、不启用业务配置、不更改核心或依赖。
