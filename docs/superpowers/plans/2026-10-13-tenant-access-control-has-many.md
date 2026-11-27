# 租户访问模型：一对多绑定与解绑

在 `feat/tenant-access-control` 继续实现内部服务，验证后按职责提交，不升级依赖、不修改业务数据库或线上。使用 writing-plans、executing-plans、test-driven-development、requesting-code-review 和 verification-before-completion。

## 范围与接口

新增 `access-control/has-many-metadata.ts` 核实真实 HasMany 关系；新增 `access-control/has-many.ts` 实现 `AccessHasManyService.withChildren(ctx, source, target, authenticated, request)`。请求为：

```ts
{
  association: string;
  operation: 'add' | 'remove' | 'set';
  sourceKey: string | number;
  targetKeys: Array<string | number>;
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  targetReadWhere?: WhereOptions;
  targetReadBind?: Record<string, unknown>;
}
```

返回实际变化目标的 `{keys, affected}`，不回读业务详情。只支持同库、不同模型、单主键、来源主键作为关联键的普通 HasMany；不接受嵌套 values、排序、删除目标、自关联或带 scope 的关系。

来源 G；明确传入目标检查可读，并叠加 `targetReadWhere`。计算真实外键差集后，对所有实际变化目标检查 G 和 `targetWhere` 更新条件，包括 `set` 隐式解绑的旧目标。保持原样的目标不作为编辑或认领处理，但明确传入时仍需通过读取条件。绑定已经属于另一来源的目标只改目标外键，旧来源内容不被修改。入口适配器负责操作和字段 ACL，两组目标条件必须由服务端分别从读取和更新权限产生。

PostgreSQL SERIALIZABLE 事务先锁来源，再按主键顺序对候选目标取 UPDATE 锁，随后检查明确目标的读取权限，避免先 SHARE 后 UPDATE 的锁升级死锁。全部实际变化目标按修改前状态完成授权，最后按差集逐项通过目标 Repository 更新。实际变化时认领历史来源和历史目标；纯引用或无变化不认领。实际归属和其他受保护关系键写后核对；合法写入退出原 G 仍成功。序列化冲突 `40001` 和死锁 `40P01` 均返回 409，不自动重跑或发回滚通知。

`relationship-write-guard.ts` 仅在本次 Repository 写入的异步上下文中安装临时查询 Hook，要求来源和目标两表的实际 ORM 写入恰好为一个已授权实例的 UPDATE，且事务未被替换。写入结束立即移除检查。它防止业务 Hook 顺带修改这两表的其他记录，不是全局关联拦截，也不承诺检查主动使用裸 SQL 或其他表产生的业务副作用；后续入口适配须单独核查这些副作用。

## 实施步骤

- [x] 在 `__tests__/access-control/has-many.test.ts` 建立独立库样例，先验证服务尚不存在的失败结果。
- [x] 实现元数据检查及 add/remove/set 的最小差集写入。核心 HasMany 的 set 会隐式清除外键，服务不能只检查请求中的新目标。
- [x] 验证来源只读、明确目标只读、隐藏目标、缺失目标、隐式解绑目标只读、角色条件、保持旧只读关联和整批回滚。
- [x] 验证历史来源及目标仅在实际变化时认领、解绑历史目标、引用不认领、修改前 G、写后退出 G、共享表不强求 tenantId。
- [x] 验证未知输入、跨库、元数据替换、复用外键、不支持关系、过大批次、外键不可为空。
- [x] 验证 Hook 扩大写入范围、替换事务、改错外键或归属时回滚，afterCommit 仅成功后通知；增加仅限本操作的实际写入检查。
- [x] 使用真实 PostgreSQL 并发验证撤权和写入冲突，运行聚焦测试、访问模型联合回归、严格类型检查、lint、格式检查及租户模块构建。
- [x] 独立审查后更新规格和本计划的真实验证结果。业务入口继续保持未启用。

测试库由现有独立 PostgreSQL 运行脚本创建，随机名称严格匹配 `tego_tenant_access_test_[a-f0-9]{10}`，结束精确删除；SQLite 仅验证关系写入被拒绝。

```powershell
cmd /d /c pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/has-many.test.ts --no-file-parallelism --reporter=default
cmd /d /c pnpm exec tsc --noEmit --emitDeclarationOnly false --strict --skipLibCheck --esModuleInterop --target ES2022 --moduleResolution bundler --module esnext packages/module-tenant/src/server/access-control/has-many.ts
cmd /d /c pnpm exec tegod build @tachybase/module-tenant
```

## 验证结果

2026-10-13，HasMany 聚焦测试 46 项全部通过（PostgreSQL 45 项、SQLite 拒绝未验证方言 1 项）。访问模型联合回归 18 个文件、551 项测试全部通过，无跳过；包含此前规则编译、配置、ACL、查询、根记录写入、关联引用、多对多、旧租户过滤及历史认领测试。

严格 TypeScript 检查、4 个代码文件 oxlint、代码和本文及设计文档的 Prettier 检查、`@tachybase/module-tenant` 构建均通过。独立审查发现并发锁升级死锁，已用两个真实事务复现 `40P01` 红灯，再调整锁顺序与冲突映射，复审未发现新的问题。

联合回归的原型性能样例为 20006 条根记录、40004 条参与方记录，20 条和 100 条分页 P95 分别约 2.56 ms、2.41 ms。这只验证测试样例的根查询，不代表 HasMany 写入或实际业务页面的性能验收。

测试临时库已精确删除；两仓保持 `feat/tenant-access-control`，未升级依赖、未修改业务数据或线上。普通 HasMany 内部服务完成，业务中间表、其余关联适配、资源和后台任务入口、配置界面以及真实业务试点仍未验收。

后续 HasOne 阶段将元数据检查和事务流程分别移至 `target-foreign-key-metadata.ts`、`target-foreign-key.ts` 复用；`has-many.ts` 的公共接口保持不变。详见 [一对一替换与解绑计划](2026-10-13-tenant-access-control-has-one.md)。
