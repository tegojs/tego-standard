# 具体来源的一对多列表与关联详情接入计划

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

## 后续：具体来源关联详情

沿用已批准的读取模型，增加内部 `getAssociationFromParams`，与列表共用来源定位、权限路径、关系约束和生命周期检查。不注册业务路由，不改变核心或业务配置。

核心 `get` 调用关联仓库的 `findOne`。HasMany 的目标键来自关联字段的 `targetKey`，默认是目标主键，不是根表的 `filterTargetKey`；本阶段只支持主键目标，并要求明确标量键，不能省略键后返回任意记录。HasOne 通过来源关系定位，核心忽略 `filterByTk`；本入口接受省略、null 或合法标量并忽略该键，复杂值仍拒绝。来源仍限已验证的主键关联。BelongsTo、多对多和实际资源分派待后续接入。

详情执行最多 1 条的内部读取，不查询总数；权限操作始终为 `get`，不以 `list` 权限代替。来源和目标分别满足最终角色条件与 G/V；关联展开继续保留原始来源路径和祖先字段限制。关联定位键不因此获得输出或用户筛选权限。关系约束只作用于本次根查询，不污染角色内部关系事实或展开目标。

- [x] 新增详情红灯用例，确认缺少 `getAssociationFromParams` 导致失败，再实现入口。
- [x] 提取列表与详情共有的同步准备；新增严格详情参数解析及 HasOne 定位规则。
- [x] 增加来源/目标 G/V、get 权限、嵌套字段、共享目标、历史数据不认领、关系作用域及默认作用域测试。
- [x] 增加核心协议对照、业务根详情键与关联键分离、非法输入、异步快照、元数据变更、事务、日期及不执行 count 测试。
- [x] SQLite 与独立 PostgreSQL 运行详情、原有列表、根读取和关联展开回归；严格类型、lint、格式和模块构建。
- [x] 独立审查、记录结果、签名原子提交。

详情阶段验证：

- 红灯明确为缺少 `getAssociationFromParams`；实现后详情及参数专项通过 25 项 SQLite 测试。
- 四个文件在 SQLite 与独立 PostgreSQL 共通过 747 项（410.07 秒）。临时库 `tego_tenant_access_test_facfbaa5eb` 已删除并确认不存在。
- 严格 TypeScript 检查 0 个问题，聚焦 oxlint 0 个问题，格式检查通过，租户模块构建成功。
- 独立审查未发现有效问题，另独立验证 32 项参数边界检查。未启用业务路由，未修改业务数据；尚不代表真实业务页面验收完成。
