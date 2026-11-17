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

- §478（负责人独立操作必须执行持久数据范围）：沿专用 `departments:setOwner/removeOwner` 从RoleResourceActionModel的持久scope配置追到ACL参数和直接中间表写入。标准ACL将角色scope传到动作的filter，但两个自定义动作原先未查目标部门，导致过滤只存在于params、未约束副作用。新增 `authenticated-owner-action-scope.test.ts`，真实Basic登录、持久普通角色及动作授权、部门101 scope和真实部门/成员数据，逐项验证两个动作在范围内和范围外行为。首轮真实RED：两个范围外操作均200，并将102关系的isOwner从false改true或true改false；范围内两条对照通过。请求实测ACL过滤器正是持久 `{id:{$eq:101}}`，不是夹具猜测。
  - 最小生产修复在两个现有动作中通过 `departments.findOne({filterByTk:departmentId,filter:ctx.action.params.filter})` 确认目标处于ACL范围后，才写原 `departmentsUsers` 指定关系；超出范围按标准更新未命中语义不写数据，原授权状态、owner值、必填参数校验和响应链保持。修复后两动作范围内可写、范围外关系不变；原管理snippet权限、拒绝未授权、缺参400和部门表单字段/范围回归均保留。
  - 批准snapshot串行重跑7文件命令（新scope验收、owner action验收、owner field、department update scope、main department、department roles、ACL setCurrentRole）：退出0，36项通过、无skip；`pnpm exec tegod build @tachybase/plugin-department` 完整构建退出0；两TS的Prettier/oxlint通过。没有改依赖、配置或生成物。工作树/snapshot源码SHA256相同：actions=`280DB8D121AFF189B550656227A7FB6F5B0D89FDCC3B209FB8A157ECF02FDD52`，新测试=`2F8435FE3E70283E8845F9241AB51BDDA5026EE45999CC76B172D6EC9E2B8693`。
  - 作者按完整模板串行自审，非独立复核。本项限定department集合scope与两个单关系动作，不宣称用户维度scope、own语义、请求/动作自定义filter组合、部门scope并发撤权与关系写入原子性、缓存一致性、租户隔离或PG并发已验证；department是shared资源。§466核心ACL组合测试、正式安装/规则启用/浏览器试点、整分支独立复核仍待完成。旧未提交工作树改动保留；损坏PG不启动，不联系子智能体或外网，不推送、合并、部署或正式启用。

- §479（部门聚合搜索必须执行持久数据scope）：追踪左侧 `DepartmentsSearch` → `departments:aggregateSearch` → 两个直接Repository查询。新真实Basic登录测试配置持久普通角色及 `aggregateSearch` 仅允许部门101的scope，并提交同时命中101/102的搜索词。首轮RED：原处理器观测到ACL `filter:{id:{$eq:101}}`，但响应仍返回102，证明实际部门查询没有应用动作scope；数据库角色关联及部门、用户记录保持不变。
  - 最小修复仅将ACL动作filter与原id增量条件及title keyword条件通过 `$and` 合并到部门Repository查询，用户查询、父级append、分页参数和响应形状均未改。修复后同一真实响应只含101。观察发现该自定义动作的最终whitelist为undefined，但本项未以此追加字段输出修复或声称已验证字段策略。
  - 批准snapshot串行运行8文件聚焦回归：`authenticated-department-aggregate-search-scope.test.ts`、owner action scope/授权、owner update field/scope、main department、department roles及ACL `setCurrentRole`；退出0，37项通过、无skip。部门插件完整构建退出0，两个TS的Prettier与oxlint通过，无locale/依赖/配置/生成物变化。源码/snapshot SHA256一致：actions=`39D7836BFEC3845E1F0BAA57845C5C9F9115DBF16DA58B560F1DF33432614FC9`，新验收=`3974FA459AC4CBEA2C985C45506633C0D6057EE4AC8A0E7E4C926361FB8F6DB2`。
  - 作者按完整模板串行自审，非独立复核。本项只证明部门搜索结果服从department资源filter，不证明搜索用户结果的用户ACL/字段限制、关联父节点信息范围、own/dynamic scope、其它action filter组合、租户隔离或PG并发；部门是shared资源。§466核心ACL组合、正式安装/浏览器试点、整分支独立复核仍待完成；旧工作树未提交改动保留。损坏PG不启动，不联系子智能体或外网，不推送/合并/部署/正式启用。

- §480（部门聚合搜索用户分支必须尊重 users:list）：沿同一客户端搜索继续检查 `type:'user'` 分支。持久普通角色只配置 `departments:aggregateSearch`、明确没有 `users:list`，真实Basic会话搜索唯一测试用户首次RED：响应仍返回完整用户记录，包括手机号、邮箱及其他用户字段；动作授权/当前用户和角色观察、用户及角色关系后验均对应持久数据库。
  - 最小修复仅在执行聚合搜索的用户查询前通过 `ctx.can({resource:'users',action:'list'})` 要求当前角色同时具备标准用户列表权限。没有该权限仍可执行已授权部门搜索，但用户列表为空；授予现有 `pm.department` snippet 后，搜索结果仍正常返回目标用户和已有用户列表字段。部门查询过滤、关键字和分页、动作本身ACL、依赖与schema均不变。
  - 批准snapshot重跑9文件聚焦回归（新增用户权限对照、部门搜索scope、负责人操作/字段/scope、主部门、部门角色及ACL setCurrentRole）：退出0，39项全部通过、无skip；`pnpm exec tegod build @tachybase/plugin-department`完整构建退出0，新TS Prettier/oxlint通过。工作树/snapshot源码SHA256一致：actions=`B9FCFF258D9180DED050D782CCE03E089E9EFB1C97688F8DBEDF9A5FAE72A891`，测试=`5236BE522C7D76CDD3F60E52D52E7569F6A0D66ACC5B7F9B246E3074B9D370EE`。
  - 作者按完整模板串行自审，非独立复核。本项只证明用户结果受标准users:list操作许可门控，不证明users:list自定义字段白名单/数据scope进一步约束这些结果、跨实例缓存、租户隔离或PG并发。部门插件snippet授予users:list的正常路径被保留。§466核心ACL组合验收、正式安装/规则启用/浏览器试点及整分支独立复核仍待完成；原工作树改动保留，损坏PG不启动，不联系子智能体或外网，不推送/合并/部署/正式启用。

- §481（聚合搜索用户分支必须执行 users:list 数据范围）：沿§480明确未覆盖的边界，设置Basic真实登录的普通角色；持久 `users:list` action scope 仅允许用户ID 3，聚合搜索词同时命中ID 3和范围外ID 4。首次有效RED响应为 `[3,4]` 而非 `[3]`；无 `users:list` 与部门管理snippet既有对照保持原预期，完整用户行及用户-角色关联前后不变。
  - 最小修复从当前认证角色获取 `ctx.can({resource:'users',action:'list'})` 的参数，经 `ctx.tego.acl.filterParams` 和 `parseJsonTemplate` 处理，再把其filter与原增量ID及关键字条件以 `$and` 合并到用户Repository查询。空ACL params默认 `{}`，因此snippet授予但未配置额外params时仍保持可用。部门分支、搜索字段、分页及响应结构未改。
  - 修复后该认证验收3项通过；9文件部门/ACL聚焦回归40项通过；部门插件构建通过。改动TS的Prettier检查通过，oxlint 0 warnings/0 errors。首轮无效夹具因排除用户未匹配搜索词而被识别并修正，不作为RED；真实RED输出为ID `[3,4]`。批准snapshot与工作树源码SHA256一致：actions=`3E083B335EAB56EB8A76445E6290B32ACF8E671F020E6C8C486C7410A0E55F4F`，验收=`3631D4D3F5256A42D837DD382E2B55FDD1697D618DF89F4D6E8A6A5ED2DB31A3`。
  - 作者串行自审、非独立复核。本项只验证静态ID过滤scope，不证明动态模板、users:list字段白名单、排序/分页策略、租户隔离、PG并发或跨实例缓存。用SQLite内存库执行的是认证/ACL行为验收，不作为PG并发证据。§466核心ACL组合验收、正式安装/规则启用/浏览器试点及整分支独立复核仍待完成；损坏PG不启动，不联系子智能体或外网，不推送/合并/部署/正式启用。

- §482（部门添加成员候选列表必须要求部门管理许可）：沿真实客户端 `AddMembers` → `users:listExcludeDept` 检查自定义用户读取入口。角色与部门成员关系均由数据库持久化，真实Basic登录普通角色不含 `pm.department` snippet。首次RED：请求仍为200，返回候选用户完整记录，包括手机号和邮箱；该插件虽在 `pm.department` snippet 中登记该 action，却另用 `app.acl.allow(...,'loggedIn')` 给所有已登录角色全局授权。测试还确认部门成员过滤结果符合候选列表语义、请求没有改动用户/角色/部门成员数据。
  - 最小修复仅移除 `users:listExcludeDept` 的全局 `loggedIn` ACL放行；保留 action 注册、处理器与 `pm.department` snippet。普通角色现在403且无业务data；持久授予部门管理snippet后仍返回预期候选用户和联系方式。
  - 修复后新增真实认证验收2项通过；11文件部门/ACL/相邻用户列表聚焦回归44项通过；`pnpm exec tegod build @tachybase/plugin-department`构建通过；新TS Prettier通过、oxlint 0 warnings/0 errors。批准snapshot与工作树SHA256一致：plugin=`7CBDB39A458F13B9781CF6D34C6C35169B976FEB7F8680ABB70CD6521B4F20ED`，验收=`433953055AF789346FC4CD05965CB483B5476213F4C21AAC59626215FCB07DFF`。
  - 作者串行自审、非独立复核。本项只证明已登录但未持久获部门管理snippet的角色不能读取该候选用户列表；未单独测试未登录请求，也不证明users:list字段白名单或数据scope会自动应用到此自定义action、租户隔离或PG并发。SQLite只用于真实认证/ACL功能验收，不作为PG并发证据。§466核心ACL组合、浏览器试点与整分支独立复核仍待完成；损坏PG不启动，不联系子智能体或外网，不推送/合并/部署/正式启用。

- §483（部门聚合搜索用户结果必须遵守 users:list 字段白名单）：沿§482未覆盖的用户列表字段边界，复用真实Basic登录、持久普通角色、`departments:aggregateSearch` 与 `users:list` 配置；后者仅允许 `id`、`username` 且按持久scope筛选匹配用户。测试原先只断言结果ID。补充行为断言后的首轮RED：范围内用户仍从聚合搜索响应暴露phone、email、nickname、status及其他字段（16个字段），尽管ACL params带有 `fields: ['id','username']`；无 `users:list` 与部门snippet授权的既有对照继续通过。
  - 根因是自定义处理器解析并使用了用户列表ACL filter，却调用直接Repository查询时未转交解析后的 `fields` 投影。最小修复将同一已解析 `fields` 传给 `users.find`；用户scope、关键词/增量ID过滤、分页、部门分支与snippet未配置字段时的既有行为未改。仓储仍自动附加 `createdAt`/`updatedAt`，验收明确允许这两个标准时间字段，同时精确拒绝白名单以外的其它用户字段。
  - 批准snapshot首先重跑该验收文件，首轮1项按预期失败、2项通过，RED实际值包含phone与email；修复后单文件3项通过。9个部门/ACL聚焦文件通过32项（含新增验收），`pnpm exec tegod build @tachybase/plugin-department`构建退出0，改动TS的Prettier检查通过且oxlint 0 warning/0 error。SQLite只承载真实认证/ACL功能验收，不作PG并发证据；工作树/snapshot SHA256一致：actions=`E7B62689A2551561A27C176CD781A550832C6516AF400323B669B1C61DEC8D9B`，验收=`120314289FC37006DC2BED70EAF27224BEC8C1F7871A6CDCC25C1CD511719403`。
  - 作者串行自审、非独立复核。本项只验证静态 `users:list` 字段白名单在部门聚合搜索用户结果中的投影，不扩张到字段动态模板、排序/分页许可、未登录、租户隔离或PG并发。§466组合验收、正式试点及整分支独立复核仍待完成；保留既有未暂存tenant测试，不启动损坏PG，不联系子智能体或外网，不推送/合并/部署/正式启用。

- §484（部门候选列表必须应用 users:list ACL）：沿 `AddMembers` → `users:listExcludeDept` 的真实客户端与服务端入口检查§482之后仍未覆盖的标准用户列表ACL。真实Basic登录、持久角色获候选action及 `users:list`；后者scope仅匹配用户ID 4、字段仅允许 `id`/`username`，而候选action自身字段允许包含phone/email。首次有效RED：候选响应返回范围外ID 5（`[4,5]`，预期 `[4]`），并携带用户列表白名单外的联系方式。另一个独立有效RED：角色仅被授予 `users:listExcludeDept`、未获 `users:list` 时仍能收到完整候选用户行。初次无效夹具因users资源级配置未包含当前候选action而被ACL正确拒绝（403）；补上该action持久授权后才将复现作为RED。
  - 根因是候选处理器只应用自定义action filter并直接执行 `findAndCount`，没有获取、解析或执行 `users:list` 的授权。修复在查询前要求 `ctx.can({resource:'users',action:'list'})`，缺少时返回空列表；有权限时将标准ACL解析出的filter与候选action filter合并，并把fields投影传到仓储。部门成员排除、分页、管理snippet默认返回phone/email的既有体验不变；受限角色返回scope内、仅白名单字段的候选用户。
  - 批准snapshot的9个部门/ACL聚焦文件34项通过（包含该4场景验收）；插件构建退出0；格式检查通过、oxlint 0 warning/0 error。格式化后的改动文件重新运行聚焦验收4项通过。SQLite仅用于真实认证/ACL功能验收，不作为PG并发证据。工作树/snapshot SHA256一致：actions=`FCD5EE33812B24080F59BD0EDFA004431E485DFD191D5906238ECA5443843FCD`，验收=`BDA23A5A86278C370066DCE611E7483F959E31FF746A54E3529B252F7D1E3FBA`。
  - 作者串行自审、非独立复核。本项仅覆盖静态 `users:list` filter/fields 与缺失许可的fail-closed行为，不证明动态scope、租户隔离或PG并发。保留既有未暂存tenant测试；§466组合验收、正式试点及整分支独立复核仍待完成；损坏PG不启动，不联系子智能体或外网，不推送、合并、部署或正式启用。

- §485（部门聚合搜索不能通过父级展开泄露scope外记录）：沿 `DepartmentsSearch` 的真实 `NodeLabel(parent)` 展示追踪 `departments:aggregateSearch`。Basic真实认证角色通过数据库持久配置scope仅允许部门101，字段明确允许 `id`、`title`、`parent`；部门101的父级100不满足同一持久filter。首次有效RED：搜索仅命中并返回部门101，却同时附带其父级100完整对象及标题，尽管处理器观测到 `filter:{id:{$eq:101}}`。用户、部门原始记录和角色关系读前/读后保持不变。无scope的部门管理角色是保留现有路径展示行为的对照。
  - 根因是自定义查询仅把ACL filter用于顶层Department查询，却无条件以 `appends:['parent(recursively=true)']` 加载关联链；Repository append没有沿用当前查询filter。最小修复在当前部门filter非空时不展开父链；无受限filter时仍递归返回父级，因此不改变无scope管理搜索的原有标签展示。该行为在真实Basic未受限管理角色对照中验证。
  - 批准snapshot串行执行9个部门/ACL聚焦文件：34项全部通过、无skip；部门插件构建退出0；改动TS Prettier通过、oxlint 0 warning/0 error。新增真实Basic父链拒绝与无scope管理路径对照均通过。SQLite仅承载功能验收，不作为PG并发证据；工作树/snapshot SHA256一致：actions=`5BB785D11FE331A02631EB8F7EF01B986BEAAB08C821DAAAEAE0EF25FC30AF0E`，验收=`8D62DEA75AE2738C495BE0DC0D332EFE257B9BB7323D42256406F71E67FD9B9F`。
  - 作者串行自审、非独立复核。本项仅防止带有静态部门ACL filter时通过递归parent append返回范围外父记录；无scope父链及持久scope拒绝行为有真实认证对照。未证明复杂动态filter下的逐节点部分父链可见性、其它关联展开、租户隔离或PG并发。保留既有未暂存tenant测试；§466组合验收、正式试点及整分支独立复核仍待完成；损坏PG不启动，不联系子智能体或外网，不推送、合并、部署或正式启用。

- §486（主部门写操作必须执行持久 users action scope）：检查部门用户管理界面的 `users:setMainDepartment` → `departmentsUsers` 事务写入口。真实Basic登录角色仅获该action且持久scope为 `users.id = operator.id`；请求以另一用户 `target.id` 切换主部门。批准snapshot首次RED返回200并实际将目标用户101关系 `isMain` 由true改false、102关系由false改true，其他用户关系未变。根因是自定义action虽由ACL授权，但事务更新只用请求 `userId`，没有按 action permission 的filter核对目标用户。
  - 最小修复在事务前读取当前 `users:setMainDepartment` permission，经 `filterParams` 与 `parseJsonTemplate` 得出filter，并将其与 `filterByTk: userId` 一并用于users查找；目标不在scope时跳过关联写入并继续中间件。原事务、部门管理snippet授权和scope内行为不变。真实scope外认证验收通过且三行成员关系完整不变；已有无管理snippet拒绝/有snippet允许对照继续通过。
  - 批准snapshot执行9个部门/ACL聚焦文件38项全部通过、无skip；`pnpm exec tegod build @tachybase/plugin-department`退出0；Prettier检查通过，oxlint 0 warnings/0 errors。工作树/snapshot SHA256一致：actions=`F9C97C3A283709A4E8FD0543B3A8B206D06F3B9719F67A4C4B939930CC5D2757`，验收=`E9C9BF1C5E87973927B1B0FAD8DD3E51289416538B74A2953EA9203E35FCC1F1`。SQLite仅作认证/ACL功能验收，不作PostgreSQL并发证据。本项只证明静态users ID scope限制主部门目标用户，不证明动态scope模板、部门目标关联授权、租户隔离或PG并发。作者串行自审、非独立复核；§466组合验收、正式试点和整分支独立复核仍待完成；保留已有未暂存tenant测试，不启动损坏PG，不联系子智能体或外网，不推送、合并、部署或正式启用。

- §487（用户-部门关联写入必须执行持久关联 action scope）：沿用户资料 `UserDepartmentsField` 的真实 `users.departments:add/remove` 路径检查作用于关联源用户的持久scope。Basic真实登录角色具有 `pm.department`，`users.departments` 的对应持久action scope只允许操作员ID；向scope外目标用户添加部门的首次RED确实在 `departmentsUsers` 新增了目标行。根因是通用ACL关联请求处理移除了association permission的filter，之后只按基础源资源动作检查来源记录是否存在，未应用该关联动作scope。
  - 新增 `checkUserDepartmentAssociationScope` 前置守卫，在 `setCurrentRole` 之后、ACL/core之前读取当前关联action授权参数，经过 `filterParams`/`parseJsonTemplate` 后按来源user主键查验；范围外add/remove返回403，真实关系保持不变。真实scope内add/remove对照均成功，原有主部门默认处理器保持后置执行。
  - 批准snapshot执行12个部门/ACL聚焦文件47项全部通过、无skip；`pnpm exec tegod build @tachybase/plugin-department`完成；Prettier通过，oxlint 0 warnings/0 errors。工作树/snapshot SHA256一致：plugin=`950B4E874EF070177029A82B8860FD95742446C51CD8A84D1AC54259BD5E41CE`，middleware=`1714AB964E98066B366C75B568125CDECA48944039DB7D75739EA89B3ADDD6ED`，验收=`C34CACB63988022924D8AF500EC60DD72B8133B41BCB5AD7CBD1942F98626687`。SQLite仅作认证/ACL功能验证，不作PG并发证据。本项证明静态来源用户ID scope约束该插件的users.departments add/remove，不证明动态scope表达式、其他关联字段、租户隔离或PG并发；作者串行自审、非独立复核，§466组合验收、正式试点及整分支复核待完成。保留已有未暂存tenant测试，不启动损坏PG，不联系子智能体或外网，不推送、合并、部署或正式启用。
- §488（用户-部门关联写入执行目标集合 ACL scope）：在 §487 来源用户scope验收基础上，新增真实Basic/持久ACL对照：角色有 `users.departments:add`，`departments:list` 持久filter仅允许101；真实普通列表只返回101。将范围外102通过 `users.departments/:id/add` 加到本用户时，请求403且 `departmentsUsers` 完整关系不变，证明目标集合范围仍受执行。未发现生产RED，不改运行时代码。
  - 批准snapshot中运行 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-user-department-association-scope.test.ts --no-file-parallelism --reporter=default`：1文件3项通过、无skip（§487来源scope add/remove与§488目标scope）。Prettier检查测试和两份记录通过；oxlint测试文件0 warning/0 error。测试源码SHA256在工作树与批准snapshot一致：`4768F05DC24ECB19C0D80840D74FE6EFAF118F09220648E2089B603BCFDEA229`。纯验收及记录变更，没有生产源码/依赖/schema变化，因此不构建包。本项只覆盖静态 `departments:list` scope与关联add，不证明动态scope、remove目标范围、租户隔离、PG并发、正式试点或整分支独立复核。§466 factory组合验收仍未通过；不启动损坏PG，不联系子智能体/外网，不推送、合并、部署或正式启用。
- §489（部门关联移除遵守目标集合 ACL scope）：沿 `UserDepartmentsField` 的真实 `users.departments:remove` 路径补齐 §488 未覆盖的目标侧移除。角色持久 `departments:list` filter 仅允许101，普通列表只返回101；先为操作用户建立指向范围外102的持久关联，再通过真实Basic会话尝试移除。请求403且关联行完整不变，没有生产RED和生产代码改动。
  - 批准snapshot串行运行 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-user-department-association-scope.test.ts --no-file-parallelism --reporter=default`：1文件4项通过、无skip，包含§487来源scope add/remove、§488目标scope add及本项目标scope remove。Prettier检查测试和两份记录通过，oxlint测试文件0 warning/0 error；测试源码SHA256在工作树与批准snapshot一致：`8FEA3B549A6D7F2C63036182AED7D944DF6E1568F692CEFFD64AB7112D9B321A`。仅测试和记录变化，没有运行时代码/依赖/schema修改，故不构建包。本项只证明静态目标 `departments:list` scope下remove被拒绝，不证明动态scope、其他关联字段、租户隔离、PG并发、正式试点或整分支独立复核；§466核心ACL factory组合验收仍未完成。不启动损坏PG，不联系子智能体/外网，不推送、合并、部署或正式启用。
- §490（角色-部门关联添加必须遵守目标集合 ACL scope）：检查角色编辑器真实 `roles.departments:add` 写入口。操作员通过Basic认证，持久角色同时具有 `pm.acl.roles` 和 `pm.department`；目标部门 `departments:add` 明确允许关联操作，`departments:list` 的持久scope仅允许ID 101。真实列表只返回101，关联101成功。首次有效RED：关联范围外102仍返回200，且持久 `departmentsRoles` 新增 `(targetRole, 102)`；因此不是仅响应码异常。初期403对照因测试角色缺少来源/目标关联动作权限而是无效夹具，未计为RED。
- §491（角色-部门关联移除必须遵守目标集合 ACL scope）：检查角色编辑器真实 `roles.departments:remove` 路径（`useBulkRemoveDepartments`）。复用真实Basic认证与持久 `departments:list` scope（仅ID 101）；测试角色明确获 `departments:remove`，列表确实只返回101。范围内101的移除成功。为证明新测试可捕获缺口，在批准snapshot中将现有守卫临时变异为仅拦截add；真实认证下越界102随后返回200且持久 `departmentsRoles` 关联行被删除，构成有效变异RED。早先403对照因夹具未授予 `departments:remove` 而无效，已补齐后才运行RED。当前分支的双动作守卫通过了该场景；本项仅补验收覆盖，不改生产实现。
  - 批准snapshot最终执行3文件聚焦测试（角色关联、用户关联、主部门）：8项全部通过、无skip；`pnpm exec tegod build @tachybase/plugin-department`退出0；Prettier通过，oxlint 0 warning/0 error。仓库 `read_lints` 工具在本会话不可用，以项目oxlint代替。工作树/snapshot SHA256一致：middleware=`E3D2E984D8872E7BF35BD617427159B14D835A8B7F583FEDE739E7B7675DCEA9`，认证验收=`B278FA24FE0570F0267D61C50C4C7DA65E2F8BD1D2BC447C60BDC62F6A79F163`。SQLite仅用于Basic认证/ACL与持久功能验收，不是PostgreSQL并发证据。本项不证明动态scope、租户隔离、PG并发、§466组合验收、正式试点或整分支独立复核；不推送、合并、部署或正式启用。

- §492（角色详情的部门关联列表必须应用目标集合 ACL scope）：沿 `Departments.tsx` 的真实页面读取 `roles/{role}/departments:list`，在Basic认证下操作员的持久 `departments:list` scope 仅允许101，但已关联角色的结果仍包含101与102，构成真实RED。根因是通用ACL对关联请求移除关联 permission filter 后只校验来源角色，不应用目标 `departments:list` filter。
  - 扩展插件现有 `checkRoleDepartmentAssociationTargetScope`：对 `roles.departments:list` 解析目标部门列表ACL scope，并以 `$and` 与原请求filter合并后交给核心查询；关联 add/remove 仍使用原有目标ID检查。真实列表现在仅返回101，用户额外请求 `id=102` 时返回空列表。进一步的变异验收证明若覆盖而非合并原请求条件，该筛选会错误返回101。批准snapshot三文件聚焦回归8项通过、无skip；部门插件构建退出0；Prettier通过、oxlint 0 warning/0 error；`read_lints`工具不可用。工作树/snapshot SHA256一致：middleware=`6340760F00BC0C862D891E2562E25B2B619F74368C4809C495DCC044740FF73B`，认证验收=`4BD2510B0B40C433EC432D880F8D0F92C3E130C216634873BF30B3A6F5F84042`。本项只验证该页面、静态ID scope和请求filter交集；不证明动态scope、关联父级append的逐节点ACL、其他关联读、租户隔离或PG并发。SQLite仅作认证/ACL持久功能验收；不推送、合并、部署或正式启用。

- §493（角色详情部门列表的父级 append 边界）：继续按 `Departments.tsx` 的实际 appends 参数检查层级名称读取。Basic认证角色 `departments:list` scope 仅允许部门101；持久部门101的父级100不在范围内。真实 `roles/{role}/departments:list` 请求带 `parent` 和递归父链后，只返回101且响应不包含 `parent`，没有发现生产RED，因此不改运行时代码。
  - 将该认证响应断言并入角色部门关联工作流回归。批准snapshot目标测试文件2项通过；Prettier通过，oxlint 0 warning/0 error；本项仅测试及记录，无运行时代码/依赖/schema变化，不需包构建。`read_lints`工具不可用，以oxlint检查。工作树/snapshot测试SHA256一致：`B4D86E2BD87B7031B35149B7ADEDBF37857A5BD9153ADAE63458C28E753A35F5`。SQLite仅用于认证/ACL功能验收，不作为PG并发证据。本项仅证明该页面的父级append未带回此静态scope外父记录，不代表动态scope、其他关联层级、租户隔离或PG并发；§466组合验收、正式试点及整分支独立复核仍待完成，不推送、合并、部署或正式启用。

- §494（角色编辑器添加弹窗的部门候选父级范围）：沿 `Departments.schema` → `DepartmentTable` → `useDataSource` 检查真实 picker 请求 `departments:list`，其中 appends 为 `roles` 与递归 `parent`。同一Basic认证用户的持久列表scope仅允许101，101父级100在范围外；候选响应只含101且不返回父级100，没有生产RED，不改运行时代码。
  - 将该候选API请求及父级断言加入同一真实角色管理认证流程。批准snapshot角色关联测试文件2项通过；Prettier通过，oxlint 0 warning/0 error；没有运行时代码/依赖/schema变化，不需包构建。工作树/snapshot测试SHA256一致：`2B6A1A50A0675017AEB9D7C6EB66D4A94DE5BAC38DE61305BB9AABE05812C7B5`。SQLite仅用于认证/ACL行为验收，不作PG并发证据。该结果只证明picker的静态部门ID scope和此父级append，不证明动态scope、其他候选入口、租户隔离或PG并发；不推送、合并、部署或正式启用。

- §495（主部门写入必须校验目标部门 scope）：复核未提交的部门 picker `roles` append 假设时，真实 `/roles:list` 同样返回目标与所谓“隐藏”角色；这是 `pm.department` 明确授予 `roles:list` 的既有宽权限，不构成 append 专属泄露，撤销了该候选测试/生产改动。随后检查未覆盖的 `users:setMainDepartment` 持久写入口：Basic登录角色的 `users:setMainDepartment` scope 允许目标用户，`departments:list` scope 仅允许101，普通部门列表也只返回101。原处理器仍接受将该用户主部门改到102，返回200且 `departmentsUsers` 两行 `isMain` 实际翻转，形成真实RED。
  - 最小修复放在 `actions/users.ts`：沿用现有用户action scope查找；仅当用户确实在来源scope中且传入 departmentId 时，要求 `departments:list` 权限并用同一ACL `filterParams`/模板解析后按目标ID查找。无目标权限或目标不在范围时403并不写；来源用户本来不在scope时继续既有无操作/200语义。真实认证验收确认101可见、102写入403、两条成员关系完整不变，同时原用户scope拒绝行为保持不变。
  - 批准snapshot命令 `pnpm exec vitest run packages/plugin-department/src/server/__tests__/authenticated-main-department-action-scope.test.ts packages/plugin-department/src/server/__tests__/authenticated-main-department.test.ts packages/plugin-department/src/server/__tests__/authenticated-user-department-association-scope.test.ts packages/plugin-department/src/server/__tests__/authenticated-role-department-association-scope.test.ts packages/module-acl/src/server/__tests__/setCurrentRole.test.ts --no-file-parallelism --reporter=default`：5文件20项通过、无skip；`pnpm exec tegod build @tachybase/plugin-department`退出0；改动TS Prettier检查通过、oxlint 0 warning/0 error。`read_lints`工具不可用，依项目规则用oxlint替代。工作树/批准snapshot SHA256一致：actions=`A799DA7A58284A1C118762AEB000AEF148E4666BD82A57B7C245426034C4EFDC`，验收=`D76BBE3F43B619EA576C36CF76F624C0ECF43626058B2E63C1B8105DB615E567`。SQLite仅承载真实Basic认证、ACL及持久关系功能测试，不作PG并发证据。本项只证明静态部门ID scope目标检查与既有用户scope语义，不证明动态scope、自助策略、租户隔离或PG并发；作者串行自审而非独立复核。损坏PG不启动，不联系子智能体或外网，不推送、合并、部署或正式启用。
