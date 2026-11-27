# 读取入口角色条件接入计划

**目标：** 将已完成操作授权与变量解析的角色权限接入统一内部读取，支持关联型角色条件，并在列表、详情、计数和根字段汇总中保留同一权限边界。

**架构：** 新增 `AccessEntryReadService`，每次操作创建独立授权计划。入口回调接收本次操作种类、可信上下文、来源表身份及当前用户/租户身份，显式提供最终授权结果，不自动映射 ACL 操作。复用 `AccessReadGrantAdapter` 校验字段权限，角色 filter 单独交给 `AccessRoleFilterCompiler`。交给现有读取链的 grant 仍只有可复制的数据；元数据检查函数保存在操作内，读取服务在首次 await 前和实际查询前后统一调用。授权事实不递归目标读取权限；用户筛选、排序仍执行每跳 G/V 与 ACL。本阶段不注册资源或切换业务页面。

**文件：**

- 新增 `packages/module-tenant/src/server/access-control/entry-reads.ts`：每次读取的权限解析、角色条件编译和生命周期组合。
- 修改 `packages/module-tenant/src/server/access-control/read-grants.ts`：共享原始权限校验，增加带生命周期检查的 `capturePlan`；原有 `capture` 继续只接受根字段角色条件。
- 修改 `packages/module-tenant/src/server/access-control/reads.ts`：增加内部授权生命周期回调，在统一检查点执行。
- 修改 `packages/module-tenant/src/server/__tests__/access-control/reads.test.ts`：真实双库与真实 ACL 的关联角色条件、字段/操作拒绝、筛选排序、授权事实不输出、元数据变化、并发与重复调用隔离。
- 更新设计进度与验收结果。

## 步骤及验收

- [x] 先写关联角色条件读取失败测试：角色条件允许使用不可读项目事实，四种操作得到同一根记录集合；输出字段不扩大。
- [x] 实现每次操作独立组合。来源和目标权限通过入口回调提供，未经解析的变量、坏身份和未知权限参数仍拒绝。
- [x] 验证角色关系变化在 G/V 查询期间、排序期间以及实际读取后均拒绝返回；排序专用目标的角色条件同样检查。重复和并发调用不能复用其他操作的权限快照。
- [x] 运行 reads、read-grants、role-filter、sort 聚焦双库回归；严格类型、lint、格式与租户包构建通过。PostgreSQL 使用独立随机测试库并删除确认。
- [x] 独立审查并修正有效问题，更新文档；本阶段整体原子化签名提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/read-grants.test.ts packages/module-tenant/src/server/__tests__/access-control/role-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/sort.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。

审查修正：转换权限前复制或展开参数会丢掉非枚举的字段限制、`own` 及未知属性，也可能把自定义数组原型变成普通数组。已用失败回归复现，改为直接校验原始权限及字段列表，再保存快照；保留合法的非枚举字段限制，拒绝未解析 `own` 和不支持的输入。复审未发现仍有效的阻塞问题。

验证记录（2026-10-15）：上述四组 SQLite / PostgreSQL 回归共 300 项通过，其中读取服务 122 项、原权限转换 82 项、角色条件编译 66 项、排序 30 项。严格 TypeScript 为 0 诊断，修改代码的 oxlint 为 0 警告及错误，Prettier 检查与租户包构建通过。专用本地 PostgreSQL 测试库已删除并查询确认不存在。独立复审另外核实原始权限描述符、操作上下文、并发检查集与查询前后检查；未注册业务资源、启用运行时新规则或改动业务数据。
