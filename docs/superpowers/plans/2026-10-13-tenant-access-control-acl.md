# 租户访问模型：角色权限接入计划

> 在当前功能分支按 executing-plans 和 test-driven-development 执行；验证后按职责提交，不升级依赖、不启用业务表。

**目标：** 在固定条件和请求条件合并之前，识别可以委托给新模型的内置租户范围；保留角色操作权限、字段权限和自定义限制。

**架构：** 核心 ACL 提供显式注册的同步参数扩展点，仅在原角色已授予操作后调用。standard 在持久化 scope 转成角色授权时记录服务端来源，新模型适配器只委托原样的内置范围。身份及配置由服务端请求快照提供，HTTP 参数中的标记不参与判断。

**技术栈：** TypeScript、现有 ACL、Vitest、SQLite。

## 1. 核心合并前扩展点

文件：核心仓库 `packages/acl/src/acl.ts`、`packages/acl/src/__tests__/action-params-resolver.test.ts`。

- [x] 先测试未注册行为、原角色无权时不能被授予、别名、策略、单次固定条件计算和请求隔离，确认扩展点缺失导致失败。
- [x] 增加 `registerActionParamsResolver`，返回注销函数。调用时传入服务端 `ctx`、实际 ACL 和权限来源；修改的是当前调用的参数副本。
- [x] 扩展点位于固定条件合并前；拒绝异步或非法返回值，禁止把异常当作空过滤。
- [x] 运行核心 ACL 全部测试、聚焦 lint 和包级构建。

## 2. 持久化范围来源

文件：`packages/module-acl/src/server/model/RoleResourceActionModel.ts`、`packages/module-acl/src/server/scope-provenance.ts`、`packages/module-acl/src/server/__tests__/scope-provenance.test.ts`。

- [x] 用真实 Database、scope 模型和 `writeToACL` 测试来源；主数据源与外部 scope 模型分别覆盖。
- [x] 来源在 `grantAction` 前复制，授权后绑定实际 role、resource、action 和授权对象；通过 WeakMap 保存，不进入权限 JSON。
- [x] 撤销、重授予、运行时过滤修改不得复用过期来源；查询来源返回独立副本。

## 3. 新模型角色适配

文件：`packages/module-tenant/src/server/access-control/acl-scope.ts`、`packages/module-tenant/src/server/__tests__/access-control/acl-scope.test.ts`。

- [x] 内置范围需同时匹配持久化来源表、数据源、内置 key、完整原始条件；同 key 的自定义范围保留。
- [x] 仅服务端快照确认该表已配置新模型时委托；旧表、缺少快照、其他数据源和策略授权保持原样。
- [x] 委托只移除已证明来源的完整角色 scope；核心仍合并所有固定条件，后续仍合并请求条件；不得扫描或删除合并后 filter 中的 tenantId。
- [x] 验证用户 A/B 请求隔离、同名表、操作拒绝、字段限制、固定条件和请求筛选；测试新规则 V 扩大读取而 G 保持写范围。
- [x] 未具备核心扩展点时显式注册失败，不静默假装启用。

范围表没有 `(dataSourceKey, key)` 唯一约束，因此准备请求时从主库读取最多两条候选。只有唯一、全局且完整原样的 tenant/main 范围才可委托，还必须与角色来源的持久化 ID 相同。重复、缺失、替换或改写时保留原 ACL 限制；只在已迁移配置的阶段查一次，不在逐操作判断中查询。

## 验证结果

核心 ACL 6 个文件、40 项通过；ACL 包构建及聚焦 lint 通过。standard 新增 ACL 接入的 3 个文件、37 项通过，包括真实持久化角色配置和本地核心扩展点联合验证。现有 ACL、数据源和租户资源回归 20 个文件、126 项通过、4 项原有跳过。module-acl 和 module-tenant 包构建、严格类型及 lint 检查通过。

独立审查指出的重复 scope 身份问题已先复现再修复，复审无其他具体问题。核心依赖及版本未修改；所有新增能力仍未在插件入口注册。

## 4. 本轮边界

本轮只提供可测试的内部接入能力，插件入口不自动注册适配器。逐表迁移、真实资源和关联读写、汇总及工作流入口尚未全部接入，不能据此启用新模型。核心源码扩展点需后续随正式核心版本发布，standard 当前依赖不变。配置与身份快照不能从请求参数构造。
