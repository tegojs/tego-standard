# 一对多关联写入的最终权限接入

沿用已批准的归属性 G / 可见性 V 设计，使用 writing-plans、测试先行和独立审查。只增加内部适配器，不注册业务路由、不升级核心或依赖。

- [x] 新增 `__tests__/access-control/has-many-mutation-handler.test.ts`：真实 ACL 和 Repository 验证具体来源 add/remove/set。先确认缺少入口的失败结果。
- [x] 新增 `access-control/has-many-mutation-handler.ts`，复用 `association-link-input.ts` 捕获动作、原始主键选择和可信身份。来源必须取得同名根动作的中性最终权限，关联字段及角色条件与 G 相交。
- [x] 实际目标动作必须绑定当前目标表和角色。所有实际变化的子记录（包括 set 隐式解绑）额外满足独立根 update 的最终权限、可写外键字段和修改前 G；目标动作和 update 的角色条件取交集。外键可由物理字段或对应反向 BelongsTo 字段授权，任一相关黑名单均拒绝。
- [x] 明确选择的目标沿用已有 HasMany 服务的引用检查，包括保持原样或移除时：另取中性 list 最终权限，主键可读，满足角色条件和 G/V；没有明确目标的清空不虚构 list 权限。引用检查不能替代实际修改权限。
- [x] `target-foreign-key.ts` 及 `has-many.ts` 增加可选可信入口钩子，旧调用方保持原行为；复用 SERIALIZABLE、候选目标锁序、差集、历史认领和 Repository 写保护。异步前固定元数据，权限回调、持久化查询和响应前复核身份/准备阶段，失败整笔回滚；Repository 接收原上下文。
- [x] 验证来源仅可见、子记录仅可见、隐式解绑被拒、外键字段限制、角色条件、历史认领、无变化、异步配置失效和最终查询回滚。回归 HasMany/HasOne 低层服务及前面表单、多对多入口，完成严格类型、lint、格式和租户构建，独立审查后签名原子提交。

接口为 `AccessHasManyMutationHandler.handle(ctx, authenticated, authorizeSource, authorizeUpdate, authorizeRead)`；三个回调分别提供来源同名操作、目标 update、目标 list 已经通过完整授权链的中性上下文，不制造或改写 ACL 决策。只接受普通同库 HasMany；HasOne、嵌套对象、混合字段、业务中间表和生产启用不属于本批。

验证命令：独立 PostgreSQL 验证脚本运行本文件以及 `has-many.test.ts`、`has-one.test.ts`、`many-to-many-mutation-handler.test.ts`、`belongs-to-mutation-handler.test.ts`；严格类型脚本、变更文件 `pnpm exec oxlint` / `pnpm exec prettier --check`，以及 `pnpm exec tegod build @tachybase/module-tenant`。每次运行结束精确清理随机测试库。

本次结果：缺少入口时 11 项权限行为测试按预期失败；实现后专项测试 50 项通过、30 项跳过；五文件跨入口回归 321 项通过、81 项跳过；严格类型检查为 0 诊断，oxlint 为 0 错误，Prettier 检查通过，租户模块构建成功。未发现可复现的权限绕过；独立只读审查无阻塞问题。跳过项是本地 SQLite 中 PostgreSQL 专属测试，不代表这些 PostgreSQL 用例已运行；验证脚本使用隔离 PostgreSQL 测试库并在退出时清理。
