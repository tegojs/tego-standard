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

## 2026-11-16 接续验收记录

- §466（普通用户直接修改租户成员关系）：依赖 `TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY` 的组合测试仍因批准 snapshot 未配置该入口而 6 项全部 skip，不算通过。§471 另以默认 ACL 和真实 Basic 登录独立验收直接 `tenantUsers:update/destroy`，但不替代核心 ACL 扩展点组合场景；未改生产代码。
- §467（个人资料不能赋予特权 specialRole）：真实 Basic 登录后，用户模块和分享插件的 `users:updateProfile` 均可将持久 `specialRole` 从空值写成 `root`（RED）。两个处理器把该字段加入既有 blacklist 后，用户模块 2 项及分享插件 1 项聚焦测试通过；Prettier 与 oxlint 通过。未测试账号状态字段，也未改变它们的行为。
- §468（个人资料不能绕过账号状态管理）：真实 Basic 登录后，用户模块和分享插件的 `users:updateProfile` 均可把持久 `status` 从 `active` 写成 `pending`（RED）。两个处理器把 `status` 加入既有 blacklist 后，保留昵称更新且状态仍为 `active`；用户模块 3 项、分享插件 2 项聚焦测试通过。状态元数据和管理员状态管理流程未改。
- §469（个人资料不得绕过专用密码修改验证）：真实 Basic 登录后，两个 `users:updateProfile` 入口均可直接替换密码，旧密码随后 401、新密码 200（RED）；专用 `auth:changePassword` 则校验旧密码。两个处理器把 `password` 加入既有 blacklist 后，资料昵称仍可更新，旧密码 200、新密码 401；用户模块 4 项、分享插件 3 项聚焦测试通过。
- §470（个人资料不得设置密码重置令牌）：真实 Basic 登录后，用户模块及分享插件的 `users:updateProfile` 均能把攻击者已知 `resetToken` 写入持久用户；之后无凭据 `auth:resetPassword` 返回 200，允许新密码登录、旧密码失效（RED）。两个处理器把 `resetToken` 加入既有 blacklist 后，资料更新仍可成功，但该值不落库；无凭据重置返回 404，旧密码仍为 200、新密码为 401。两文件聚焦回归 9 项通过，Prettier 与 oxlint 通过。仅验证本地真实认证/持久数据路径，不主张 PG 并发证据；未改变重置令牌生成/发送流程或正式启用状态。
- §471（普通成员不能直接维护租户成员关系）：真实 Basic 登录的普通B成员角色未获 `tenantUsers` 操作授权，直接更新B成员记录改为C或删除该记录均应返回403且不带业务数据，持久成员关系保持不变。批准 snapshot 中不依赖核心 ACL factory 的标准 ACL 验收1项通过；未改生产代码。此项不证明新核心扩展点组合或PostgreSQL并发。
- §472（自定义用户列表的真实 ACL 验收）：检查 `users:listExcludeRole` 的实际注册和 `pm.users.*` snippet 后，新增 `packages/module-user/src/server/__tests__/authenticated-list-exclude-role.test.ts` 两项真实 Basic 登录对照。测试显式使用 `acl: true`，从数据库创建空策略普通角色和角色成员关系，并在原 `setCurrentRole` 后只读观察实际用户/角色；无 snippet 返回403/无data，持久授予 `pm.users.*` 后返回预期两条用户记录/count2。两种情况均逐项比较完整用户行与角色成员关系，确认读取不写数据。
  - 初轮200是夹具误设：`@tachybase/test` 的 `mockServer()` 默认 `acl: false`，原新测试未覆盖该默认值，不能算生产RED。启用原ACL后两项均通过，未改生产代码。曾尝试 `roles:check` 辅助观察，但精简插件集缺少 `roles.menuUiSchemas` 关联导致500；最终改为只读请求观察点，不伪造角色或许可，也不替换处理器。
  - 批准 snapshot `D:/Dev/TegoJS/.tenant-integration-8037f223c/snapshot` 内运行 `pnpm exec vitest run packages/module-user/src/server/__tests__/authenticated-list-exclude-role.test.ts packages/module-user/src/server/__tests__/role-users.test.ts --reporter=default`：退出0，2文件4项通过。新TS的 Prettier 与 oxlint 均通过；工作树与snapshot该文件 SHA256 同为 `89FAE43AE997A565B1CC77F1CA778A3A39A5E92C2DA85A8FC7C999B75738E263`。纯验收测试改动，无运行时代码、依赖或导出契约变化，因此未构建包。
  - 本项只证明该自定义读取入口的操作权限和 `pm.users.*` 放行对照，不证明字段ACL/自定义scope、租户数据边界、其他自定义入口或PG并发。作者串行自审，不是独立复核；§466组合测试仍未验证。未启动或修复PG，未联系子智能体或外网，未推送、合并、部署或正式启用。

- §473（修改他人主部门必须有管理操作权限）：沿部门管理界面 `UserDepartmentsField` → `users:setMainDepartment` → `departmentsUsers` 真实事务更新链检查，发现插件把该写操作与列表一起注册为 `loggedIn`，虽然 `pm.department` 已包含同一动作。新验收使用 `acl: true`、真实 Basic 密码登录、持久空策略普通角色、另一目标用户及两条真实部门关系；原 `setCurrentRole` 后只读观察身份。无片段角色返回200并把目标主部门101切到102，持久 `isMain` 和时间戳实际改变，形成真实RED；管理片段对照正常通过。
  - 最小修复只从 `packages/plugin-department/src/server/plugin.ts` 的 `loggedIn` 放行中移除 `setMainDepartment`，保留原操作注册、`pm.department` 授权、原事务与处理器。修复后无管理权限403/无data，完整部门成员行不变；获 `pm.department` 的普通角色200，目标两关系的主部门标记按预期切换，所有者标记、操作者关系、完整用户/部门行及角色关系不变。没有mock认证、角色、ACL或持久写入。
  - 首轮raw SQLite布尔值为0/1造成准备断言失败；读取后仅归一化布尔字段。第二轮合法写入的updatedAt预期过严，允许目标关系的正常更新时间后，得到1个真实RED/1个正常对照。单行修复后2项通过；后续4文件17项聚焦回归退出0。命令：`pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-main-department.test.ts packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts packages/module-user/src/server/__tests__/authenticated-list-exclude-role.test.ts packages/module-acl/src/server/__tests__/setCurrentRole.test.ts --reporter=default`。
  - 批准snapshot内首次 `pnpm exec tegod build @tachybase/plugin-department` 在声明阶段TS2307失败，原因是既有 `@tachybase/module-collection` 的dist声明缺失；在snapshot依次构建 `@tachybase/module-collection`（退出0）、重试完整部门插件构建（退出0）后恢复。未改变依赖/版本/lockfile，没有把首次构建失败算作通过，生成物不纳入提交。两TS的Prettier/oxlint通过。工作树/snapshot SHA256一致：plugin.ts=`4CE04B73F0D7F679AF133FDADC784A2A1D1F1BF156687D1F1293DC3C6B0D925E`，新验收=`C33F1E8CF9458C41CD318EB1CC4E0F9BF84A967E0C423000F73C4C277C57926E`。
  - 构建后同一聚焦命令增加 `--no-file-parallelism` 串行重跑：退出0，4文件17项全部通过（无skip）。按完整审查模板由作者串行自审，非独立审查。本项只证明普通未授权角色不能修改他人主部门、管理片段仍能执行正常写入；不证明已授权自定义scope/字段范围、缺失或异常参数、本人自助策略、租户边界、跨实例缓存或PG并发。其余入口与这些输入边界留待独立证据检查。§466组合验收仍未验证；正式安装/规则保存启用/浏览器试点及整分支独立复核仍待完成。损坏PG不启动，不联系子智能体或外网，不推送、合并、部署或正式启用。
