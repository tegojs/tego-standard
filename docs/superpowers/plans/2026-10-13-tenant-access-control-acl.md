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

- §474（部门编辑负责人关系必须遵守字段白名单）：检查实际部门编辑表单 `useUpdateDepartment` → `departments:update` → `setDepartmentOwners` → `departmentsUsers` 的事务写入链，发现中间件先取出owners，再在标准更新之后直接写负责人关系，遗漏最终whitelist。真实Basic密码登录、持久空策略无管理片段角色与 `dataSourcesRolesResources/actions` 明确 `fields:['title']` 验收首次即RED：请求实际whitelist只有title，更新200且目标部门负责人由用户3换成4。owners专用授权对照正常通过，非夹具错误。
  - 最小修复仅在 `set-department-owners.ts` 的原关系更新前检查最终 `ctx.action.params.whitelist`：有限白名单必须包含owners，未限定字段时保留原行为。原标准字段更新、关系事务和既有接口形状保持。新文件 `authenticated-department-owner-fields.test.ts` 三条真实认证验收：title-only正常改名但负责人完整行不变；owners-only能换负责人、夹带title不生效；持久 `pm.department` 管理片段在无whitelist时两者均正常。实际身份/角色及白名单只读观察，完整成员关系（含主部门标记、无关部门、创建时间）、用户、角色关系和无关部门行后验正确。
  - 批准snapshot执行 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-department-owner-fields.test.ts packages/plugin-department/src/server/__tests__/authenticated-main-department.test.ts packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts packages/module-acl/src/server/__tests__/setCurrentRole.test.ts --no-file-parallelism --reporter=default`：退出0，4文件18项全部通过，无skip；`pnpm exec tegod build @tachybase/plugin-department` 完整构建退出0。两TS的Prettier/oxlint通过，未变更依赖/版本/lockfile，不提交生成物。工作树/snapshot SHA256一致：middleware=`C4E0743C4127612B8627A0835DEB4D1E09E63958606166492EDF9B4EF7E4537C`，验收=`54C14922C0FD9B46B5E79EAFCB87DE4A14EC768E8FEB08C2A7193A33CF684AF8`。
  - 作者按完整模板串行自审，非独立复核。仅证明部门表单更新owners的字段白名单，不证明自定义数据scope、blacklist、空白名单/异常值、非成员负责人、setOwner/removeOwner其他入口、缓存并发、租户数据边界或PG并发。尤其原直接关系更新是否受最终数据范围约束仍需独立真实证据，未在本项扩大修复。§466组合验收仍未验证，原工作树改动保留；正式安装/规则启用/浏览器试点和整分支独立复核仍待完成。损坏PG不启动，未联系子智能体或外网，未推送、合并、部署或正式启用。

- §475（部门负责人写入必须遵守实际更新范围）：继续检查 `departments:update` 的负责人中间件及标准 action → Repository.update 契约：标准更新把最终filter和filterByTk共同筛选的模型数组放入ctx.body，但负责人写入仅按请求主键更新中间表。新增 `authenticated-department-owner-scope.test.ts`，显式 `acl: true`、真实Basic密码认证、持久空策略无管理片段角色和只允许部门101的scope。范围外102及请求title不匹配101两条路径均复现真实RED：部门物理行未变，但负责人由用户3改为4；范围内正常路径通过。
  - 初轮断言错误来自最终字段白名单的排序（owners/title）及合法更新会写updatedById，均只校正测试预期；这些失败不算生产RED。校正后运行退出1，明确2项负责人越界失败、1项范围内正常通过。最小修复在原关系写入前确认标准更新的模型数组包含目标部门，保留既有字段白名单和关系事务。采用实际更新结果，无需更新后重新匹配可能已改变的title条件；不另行解释、放宽或绕开ACL的最终filter，也不扩大为批量更新。
  - 修复后4条真实认证路径通过：范围外、范围内、请求筛选匹配修改前title、请求筛选不匹配。HTTP更新数组的命中数、完整部门行（含审计字段）、完整成员行（含主部门标记）、用户及角色关系逐项后验。和§474三项字段验收共2文件7项先通过；批准snapshot随后执行 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-department-owner-scope.test.ts packages/plugin-department/src/server/__tests__/authenticated-department-owner-fields.test.ts packages/plugin-department/src/server/__tests__/authenticated-main-department.test.ts packages/plugin-department/src/server/__tests__/set-departments-roles.test.ts packages/module-acl/src/server/__tests__/setCurrentRole.test.ts --no-file-parallelism --reporter=default`：退出0，5文件22项全部通过、无skip。`pnpm exec tegod build @tachybase/plugin-department` 完整构建退出0；两TS的Prettier/oxlint通过。工作树/snapshot源码SHA256一致：middleware=`0967A741F551EEA6E190A9D33527E6C8FD0EFCBA04999154E6ADE19F0B3C5A2B`，新验收=`D52998557EDD77AB25133C6A92938F2B64C09D99B2A357E6835F45FBD4683F6E`。
  - 作者按完整审查模板串行自审：实际更新结果约束关系副作用，未增加查询或改变标准返回；无本项必须修复的其他发现。明确保留待验范围：无/多主键及异常owners输入、非成员负责人、独立setOwner/removeOwner入口、blacklist与其他关系副作用、关系事务与标准更新的并发原子性、跨实例缓存、租户边界及PG并发，本项证据不覆盖这些行为。部门是shared表，不把本项称为租户隔离证明。§466核心ACL组合验收、正式安装/规则启用/浏览器试点和整分支独立复核仍待完成，旧工作树改动保留。没有依赖/版本/lockfile变更或生成物提交；损坏PG保持停止，未联系子智能体或外网，未推送、合并、部署或正式启用。

- §476（独立设置/移除负责人操作的真实授权验收）：检查插件注册的 `departments:setOwner/removeOwner`、客户端专用回调的完整 `values:{userId,departmentId}` 请求及 `departmentsUsers` 实际写入。两操作有独立权限名，由 `pm.department` 的 `departments:*` 授权，不走§474/475的 `departments:update` 中间件。新增 `authenticated-owner-actions.test.ts` 四条真实Basic登录对照，显式 `acl: true`、持久空策略普通角色、真实目标用户及三个部门成员关系；原setCurrentRole后只读观察实际身份，未mock认证、ACL或处理器。
  - 首次运行退出0、4项全部通过，无生产RED。无管理片段时两个操作均403/无data、完整成员行不变；持久授予 `pm.department` 时两个操作均200，仅指定用户在部门101的isOwner按方向切换、updatedAt正常更新。同部门其他用户及同用户另一部门的完整关系、isMain、创建时间、用户/部门物理行和角色关系均保持预期。没有修改生产代码。
  - 批准snapshot执行 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-owner-actions.test.ts packages/plugin-department/src/server/__tests__/authenticated-department-owner-fields.test.ts packages/plugin-department/src/server/__tests__/authenticated-department-owner-scope.test.ts packages/module-acl/src/server/__tests__/setCurrentRole.test.ts --no-file-parallelism --reporter=default`：退出0，4文件21项通过、无skip。新增TS与两份记录的Prettier、新增TS的oxlint通过；工作树/snapshot新增TS的SHA256同为 `4A7C82D42740AC871EB07B5642735BB41231B70196257FA358C6A3528670EFA0`。纯验收测试与文档改动，没有运行时、类型导出、依赖或schema变化，未重复构建包；§475完整部门包构建记录不作为本项新构建。
  - 作者按完整模板串行自审，非独立复核；本项只锁定这两个专用入口在完整单用户/单部门参数下的操作授权及写入精度。缺失/异常参数、非成员、专用操作自定义scope或字段策略、跨实例缓存、并发撤权与PG并发均未验收；不把shared部门关系等同租户边界证明，也不把客户端回调静态检查称为浏览器验收。§466组合测试及正式安装/规则启用/浏览器试点、整分支独立复核仍待完成，旧工作树改动保留。未启动或修复PG，未联系子智能体或外网，未推送、合并、部署或正式启用。

- §477（负责人专用操作缺失目标参数的错误边界）：沿§476的真实注册操作检查 `userId/departmentId` 缺省后的Repository筛选。扩展同一认证验收为10项，真实Basic登录且持久授权 `pm.department`，对setOwner/removeOwner各发送缺用户、缺部门、两者都缺的请求。首轮退出1，原4条正常授权对照通过、新6条均因预期400实际500而失败；完整成员行断言均通过。底层Sequelize拒绝undefined WHERE参数，没有发现筛选条件被删除或批量误写，不能称为越权漏洞。
  - 最小修复仅在两个专用处理器进入Repository前检查任一ID为undefined，使用已有ctx.throw/ctx.t机制返回400；部门插件全部两份locale同步新增英文/简体中文提示。保持原操作ACL和完整参数写入行为。修复后6条缺参请求均400/无data，完整关系、主部门标记、用户/部门行与角色关系不变，原无权限403及管理权限正常200对照保留。仅验证字段省略（两者都省略时客户端省略空values），不宣称null、空字符串、数组、对象或其他异常形状已验证。
  - 批准snapshot执行 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-owner-actions.test.ts packages/plugin-department/src/server/__tests__/authenticated-department-owner-fields.test.ts packages/plugin-department/src/server/__tests__/authenticated-department-owner-scope.test.ts packages/module-acl/src/server/__tests__/setCurrentRole.test.ts --no-file-parallelism --reporter=default`：退出0，4文件27项全部通过、无skip；`pnpm exec tegod build @tachybase/plugin-department` 完整构建退出0。初次Prettier发现动作文件和两JSON格式问题，格式化后三者与测试复查通过；JSON检查仍提示已有importOrder选项不适用，未修改工具配置。两TS的oxlint通过，两locale键保持同步。工作树/snapshot源码SHA256一致：actions=`910AF3D188ABB07ECAA1D490E253B9ABB408ADF69D250BAEE5509A1459CC29B0`，验收=`D81086CFBCC11D048D68691FB206A8DCD78AF16A48984D77DC1C8522EB6D4294`。
  - 作者按完整模板串行自审，非独立复核；本项是已授权写入口的缺参响应修复，不是新的租户隔离/权限绕过修复。非成员、其他异常参数、专用scope/字段策略、跨实例缓存、PG并发和§466核心ACL组合验收仍未验证；正式安装/规则启用/浏览器试点及整分支独立复核待完成。旧工作树改动保留，无依赖/版本/lockfile或生成物提交；未启动或修复PG，未联系子智能体或外网，未推送、合并、部署或正式启用。
