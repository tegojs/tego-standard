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

## 后续：具体来源资源分派

在已有根资源与占位符分派上，接入已经验证的一对多列表、一对多详情和一对一详情内部入口。路由返回明确的类型：`direct` 为根资源或占位符目标，`association` 为具体来源关系；后者只传入冻结的关联名和来源键，不能降级成目标表查询。

具体来源列表只支持 HasMany，详情支持 HasMany/HasOne；BelongsTo、多对多、关联 count/sum 和多层资源路径仍拒绝。来源键限定为有界标量，来源与目标必须有同一数据源下的独立稳定身份。角色授权操作仍以来源为根，沿实际关联路径解析；列表、详情参数及定位规则委托原有内部适配器，不复制权限或 SQL 逻辑。

`/_/` 保留核心协议：只授权真实目标，不要求来源配置或来源记录可读、不要求已有连接、不附加关系 scope。具体来源则必须检查来源权限、来源 G/V 和实际连接，再独立检查目标。这次仍不注册业务路由。

- [x] 新增实际资源分派红灯，确认具体来源请求此前因不支持而拒绝。
- [x] 扩展严格路由解析及明确类型，捕获并复核来源/目标稳定身份；`fromResource` 分派已有列表/详情入口。
- [x] 补齐具体来源、占位符、来源/目标角色与 G/V、字段路径、定位键、历史不认领、事务/日期、异步快照及身份变更测试。
- [x] SQLite 与独立 PostgreSQL 回归路由、根资源和已有具体来源读取；类型、lint、格式及租户模块构建。
- [x] 独立审查、记录结果、签名原子提交。

具体来源分派验证：

- 新增列表红灯明确为旧路由拒绝具体来源；实现后 SQLite 路由专项通过 67 项。
- 路由、根读取及目标外键读取共 3 个文件，在 SQLite 与独立 PostgreSQL 通过 472 项（253.55 秒）。临时库 `tego_tenant_access_test_b4365bed60` 已删除并确认不存在。
- 增加实际 SQL 次数对照后，具体来源分派专项在两个数据库再次通过 24 项（18.63 秒），列表和详情均不增加查询。临时库 `tego_tenant_access_test_616accd583` 已删除并确认不存在。
- 严格 TypeScript 0 项诊断，聚焦 oxlint 0 个问题，格式检查及租户模块构建通过。独立审查未发现有效问题，另运行 261 项隔离路由检查通过，访问器调用 0 次。
- 未注册业务资源，未修改业务数据或核心仓库；真实业务页面和剩余入口仍待验收。
