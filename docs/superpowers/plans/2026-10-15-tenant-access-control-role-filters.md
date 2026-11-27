# 关联角色数据条件编译计划

> 使用 test-driven-development、requesting-code-review 和 verification-before-completion 实施验收。

**目标：** 支持角色数据范围通过关联关系判断授权，例如「单据所属项目的负责人包含当前用户」。

**架构：** 新增独立 `AccessRoleFilterCompiler`，只接收入口完成变量解析后的角色条件，复用请求筛选解析器的受限语法与核心标量操作符。关联条件编译为相关 `EXISTS`，用于内部授权事实，不递归应用关联目标的 G/V 或读取 ACL，不返回关联数据。目标和中间表的默认范围、关联 scope、软删除限制保留。返回 `where` 和 `assertCurrent()`，调用者必须在执行前后检查实际模型、关系和稳定身份。

**技术栈：** TypeScript、Sequelize / FilterParser、Vitest、SQLite、独立 PostgreSQL 测试库。

## 文件与步骤

- 新增 `packages/module-tenant/src/server/access-control/role-filter.ts`：同步编译角色条件、四类关联、多层关联、逻辑组合与元数据守卫。
- 修改 `packages/module-tenant/src/server/access-control/metadata-snapshot.ts`：为现有守卫追加显式关系路径检查，保持原规则检查行为。
- 新增 `packages/module-tenant/src/server/__tests__/access-control/role-filter.test.ts`：双库实际 SQL、授权事实与响应权限分离、同项匹配、空分组与 NULL、默认范围 / 软删除 / 关系 scope、重复连接、回环路径、身份及元数据变化。
- 更新设计进度。本阶段不注册资源、不修改现有 grant 接口，不启用业务或生产新模型；实际读取入口仍需组合角色计划和原有 G/V 计划并共同检查生命周期。

- [x] 编写失败测试并执行，确认缺少角色条件编译能力时失败。
- [x] 实现同步编译；角色关联条件明确保留同一关联项匹配，不扩增根记录。
- [x] 验证坏身份、未知条件、未解析变量、未支持范围及关系变更明确拒绝。
- [x] 运行新套及元数据守卫相关双库回归、严格类型、lint、格式和租户包构建。
- [x] 独立审查、修正有效问题，更新验收记录并原子化签名提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/role-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/filter-tree.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 仅使用随机命名的本地专用测试库，退出后删除并确认。

## 验收记录

- 最终回归包含上述三套及 `metadata-snapshot.test.ts`：4 个文件、250 项测试通过。新套在 SQLite / PostgreSQL 各 33 项，关联筛选各 50 项，统一读取各 38 项，现有元数据守卫另 8 项。独立 PostgreSQL 测试库已删除并确认不存在。
- 严格 TypeScript 检查 0 diagnostics；3 个源文件的 oxlint 0 errors / warnings、Prettier 检查通过；`pnpm exec tegod build @tachybase/module-tenant` 成功。
- 初始缺功能测试失败后实现。审查发现 SQLite 大小写别名碰撞可把关联判断变成恒真；分别在 BelongsTo 和多对多实际查询中复现失败后修复。另复现编译后模型别名变化未被拒绝，已纳入共享元数据快照。修正后独立复审无阻塞问题。
- 没有注册资源、启用业务新规则、修改依赖或生产数据。当前受限语法不支持重复逻辑分支的重叠关联路径、JSON / 数组字段、日期快捷条件或任意 SQL；不支持时明确拒绝。下一阶段需接入已完成权限判定的入口，并把角色计划与 G/V 计划的生命周期共同保护起来。
