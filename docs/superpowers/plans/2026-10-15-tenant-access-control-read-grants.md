# 读取入口权限转换实现计划

> 使用 executing-plans、test-driven-development、requesting-code-review 和 verification-before-completion 执行与验收。

**目标：** 将接口入口已经完成授权、变量解析和固定条件合并的角色权限，转换为统一读取服务使用的字段及数据条件。

**架构：** 新增内部 `AccessReadGrantAdapter`，不重新决定角色或调用另一套关联 ACL。入口显式传入可信的 `allowed` 和最终 `params`；每个根、目标和中间表分别提供授权结果。转换器校验真实表身份，保存输入快照，复用现有筛选解析器编译根字段条件。角色条件可以使用未向用户开放的物理字段，但不扩大输出字段。

**技术栈：** TypeScript、现有 ACL / FilterParser、Sequelize、Vitest、SQLite 和专用 PostgreSQL 测试库。

## 边界

- 只接收最终 `fields`、`appends`、`filter` 和 `own: false`。缺省字段表示全部物理字段；明确空字段不扩大为全部。关联字段保留为可用路径，不能作为物理字段投影。
- 明确拒绝未解析变量、`own: true`、其他未适配参数、关联型角色条件、JSON / 数组 / 日期快捷条件、坏表身份和访问器，避免忽略权限限制。
- 不自动注册 API，不启用新模型，不修改业务或生产数据。内置租户范围的委托继续由现有 `AccessAclScopeAdapter` 在核心扩展点处理，不通过字符串识别删条件。

## 文件与步骤

- 新建 `packages/module-tenant/src/server/access-control/read-grants.ts`：最终入口权限到 `AccessFilterReadGrant` 的同步转换。
- 新建 `packages/module-tenant/src/server/__tests__/access-control/read-grants.test.ts`：真实 ACL 授权与变量解析结果、字段投影、拒绝授权、坏输入与快照测试。
- 修改 `packages/module-tenant/src/server/__tests__/access-control/reads.test.ts`：用真实 ACL 转换后的 grant 验证四类读取的一致性及关联目标独立限制。
- 更新设计中的实现进度和验收记录。

- [x] 先写测试并执行，确认缺少转换器时失败。
- [x] 实现转换器；用真实 ACL 的 `can`、`parseJsonTemplate` 结果测试，保留固定条件与自定义范围。
- [x] 验证字段 / 空字段 / appends、隐藏字段权限条件、拒绝授权、未解析变量和不支持条件不会放行。
- [x] 验证外部同名表、稳定表 key、输入快照、非法访问器，以及读列表 / 详情 / 计数 / 合计集合一致。
- [x] 跑聚焦 SQLite / PostgreSQL 回归、严格类型、lint、格式及租户包构建，完成独立审查；本阶段整体原子化签名提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/read-grants.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/acl-scope.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 只使用随机命名的本地专用测试库，退出后删除并确认。

验证记录（2026-10-15）：四组 SQLite / PostgreSQL 回归共 210 项通过；随后追加 NULL 与混合逻辑的双库回归，2 项通过。严格 TypeScript 为 0 诊断，oxlint 为 0 警告及错误，Prettier 与租户包构建通过。独立审查发现「空 TRUE 分组在 OR 内被 ORM 忽略，外层 NOT 扩大可读范围」，已用实际数据库失败测试复现并修复，复审无新增具体问题。自定义原型字段数组也完成失败回归与修复。专用 PostgreSQL 测试库均已删除并确认；未注册业务入口或修改业务数据。
