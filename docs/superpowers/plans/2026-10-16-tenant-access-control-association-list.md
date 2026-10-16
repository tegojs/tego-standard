# 具体来源的一对多列表接入计划

> 使用 executing-plans 执行已批准的租户访问模型；提交前独立审查。

**目标：** 内部读取桥支持指定来源记录的一对多列表，同时保留来源和目标的独立权限、目标字段限制及一致的分页总数。

**范围：** 新增 `listAssociationPageFromParams`；来源描述符只有 `association` 和 `sourceKey`，列表参数复用现有解析器。不注册业务路由，不更改核心、依赖、业务数据或现有租户中间件。`fromResource` 对具体来源仍拒绝，一对一、多对多及其他关联动作分批接入。

**契约：** 核心通过关联的 `sourceKey` 定位来源，不使用根表的 `filterTargetKey`。本阶段沿用内部元数据服务已经明确支持的单主键关联；非主键来源关联明确拒绝。来源须满足自己的最终角色条件和 G/V，目标再独立满足自己的条件和 G/V。来源的嵌套字段限制继续约束目标及其展开字段；权限内部使用的关系事实不受对外字段限制影响。

## 实施

- [x] 在 `target-foreign-key-reads.test.ts` 添加入口集成测试，先确认缺少方法导致失败。
- [x] 在 `target-foreign-key-reads.ts` 提取同步准备、异步校验来源的目标条件，原 `scopeTargets` 复用它；保持原有行为。
- [x] 在 `reads.ts`、`expanded-reads.ts` 增加仅由可信构造者提供的根条件回调。原始筛选、排序、字段和展开权限在来源查询前捕获；来源条件仅约束本次根列表，不污染内部权限事实或展开目标。
- [x] 在 `entry-reads.ts` 增加 `listAssociationPageFromParams`，复用列表解析、可信日期解析、目标选择和分页执行；权限路径保留来源关联前缀。
- [x] SQLite 和独立 PostgreSQL 验证正常、拒绝、空结果、作用域、事务、快照、异步元数据变更及固定查询次数；回归根读取和展开读取。
- [x] 严格类型检查、聚焦 lint、格式检查、模块构建；独立审查，更新设计记录。
- [x] 签名原子提交。

## 验收样例

来源 1 可读，目标 101 为 G、102 为 V、103 不可见、104 为历史 V；来源 2 的目标 105 不应混入。每页 1 条、金额倒序：第一页 104，总数 3、总页数 3。来源 3 不可见，即使目标 106 可读也拒绝。历史来源和历史目标的读取均不认领。来源允许 `children.name` 时不得返回、筛选或排序目标 `amount`。

运行：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-reads.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/expanded-reads.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。PostgreSQL 通过本地临时验证器创建独立测试库，结束后删除并确认不存在。

## 验证记录

- 红灯：新增分页用例明确报 `listAssociationPageFromParams is not a function`，随后添加实现。
- 三个测试文件在 SQLite 与独立 PostgreSQL 共通过 612 项（373.11 秒），临时库 `tego_tenant_access_test_b4a0984d94` 已删除并确认不存在。
- 最后新增边界和明确返回类型后，入口专项在两个数据库再次通过 48 项（31.72 秒），临时库 `tego_tenant_access_test_52d7281148` 已删除并确认不存在。
- 严格 TypeScript 检查 0 个问题，聚焦 oxlint 0 个问题，格式检查通过，`pnpm exec tegod build @tachybase/module-tenant` 构建成功。构建中发现新增公开方法返回类型无法生成声明，已改为明确的返回接口后重新构建通过。
- 独立代码审查没有发现剩余有效问题。查询次数测试覆盖扩大返回记录量后的稳定性；本阶段没有真实业务页面性能基准，也未启用业务路由。
