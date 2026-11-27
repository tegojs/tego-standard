# 一对一关联写入权限入口计划

沿用已批准的归属性 G / 可见性 V 和上一阶段的最终权限规则，把 HasOne 的绑定、替换和解除接入同一内部处理器。只支持同库普通 HasOne；不注册路由、不修改线上或业务数据。

## 文件职责

- `packages/module-tenant/src/server/access-control/has-many-mutation-handler.ts`：改成 HasMany/HasOne 共用的目标外键关联权限处理器；保留 HasMany 兼容导出。
- `packages/module-tenant/src/server/access-control/association-link-input.ts`：只为 HasOne 的 `remove` 支持核心省略目标选择器或空 `values`；HasMany 仍要求明确选择器。
- `packages/module-tenant/src/server/access-control/has-one.ts`：增加明确的关系解除服务入口，继续使用现有事务和写保护。
- `packages/module-tenant/src/server/access-control/target-foreign-key.ts`：HasOne `remove` 时把来源当前子记录纳入锁定和授权；HasMany 算法不变。
- `packages/module-tenant/src/server/__tests__/access-control/has-one.test.ts`：用真实 ACL、Repository 和隔离 PostgreSQL 测试覆盖最终权限入口。
- `docs/superpowers/specs/2026-10-13-tenant-access-control-design.md`：记录能力范围、权限交集和未启用业务路由的状态。

## 行为

来源必须通过同名根操作的最终权限、关联字段、角色条件和 G。`set` 的明确新目标还必须通过目标操作、独立中性 list 的主键读取、角色条件及 G/V。实际改写外键的旧子记录和新子记录必须分别通过本次目标操作、独立根 update 的可写外键（或对应反向 BelongsTo）字段、两个角色条件和修改前 G。历史认领沿用现有原子事务；实际无变化不要求 update，也不认领历史数据。

核心 `remove` 对 HasOne 调用关联 Repository 的 `remove()`，不按目标主键选择记录，而是清空当前来源关系。因此允许该动作没有目标选择器（SDK 默认发送的空 `values` 也视为无选择器）；权限仍按实际被清空的子记录校验目标 remove、目标 update 和 G。HasMany 的 remove 继续要求显式子记录主键。`set` 只允许单个标量目标，不接受数组或 null；解绑使用 `remove`。

## 执行步骤

- [x] 在 `has-one.test.ts` 增加真实 ACL 入口测试：替换目标、空 values remove、旧子记录仅 V、目标 remove/update 角色条件不符、字段拒绝、异步阶段失效；结合原有低层测试验证绑定和清空。未保留实现前的失败运行证据，不据此宣称已验证红绿循环。
- [x] 以关联类型参数抽取共用目标外键处理器，HasMany 保持现有默认行为，HasOne 仅允许 set/remove；set 限定一个主键，remove 接受无选择器。
- [x] 为 HasOne `remove` 增加低层明确入口，并在事务内锁定来源当前子记录；不影响 HasMany remove 的候选查询。
- [x] 验证 HasOne/HasMany 服务及处理器、多对多处理器和引用服务；运行改动运行时文件的严格类型检查、oxlint、Prettier、租户模块构建及独立只读审查。
- [x] 更新设计说明，检查暂存 diff 后签名原子提交（commit 924277792）。

验证使用本地验证脚本创建和删除的随机专用 PostgreSQL 测试库；SQLite 仅运行其既有不支持关系写入的拒绝测试。不得修改 `.env`、项目业务数据库、核心仓库或依赖。

## 验证结果（2026-10-19）

- 五个测试文件逐个使用独立 PostgreSQL 测试库串行执行：`has-one.test.ts` 51 项、`has-many.test.ts` 46 项、`has-many-mutation-handler.test.ts` 50 项、`many-to-many-mutation-handler.test.ts` 129 项、`reference.test.ts` 58 项通过，共 334 项；SQLite 下按设计跳过 65 项 PostgreSQL 专用用例。
- 最后一次解析器类型调整后，重新完整执行 HasOne 测试，51 项通过；各测试库运行后均已删除。
- 五个改动运行时文件的严格类型检查无诊断；测试文件和全仓严格类型检查不属于此通过结论。
- 六个改动 TypeScript 文件的 oxlint、全部改动文件的 Prettier 及 `git diff --check` 通过。
- 客户端及租户模块的包级构建成功；生成文件不提交。
- 独立只读审查未发现阻止提交的问题。此阶段仍为内部入口，不注册业务路由。
