# 租户访问模型：已有记录写入保护

> 按 writing-plans、executing-plans 和 test-driven-development 在当前功能分支完成，验证后按职责提交。只写独立测试库，不启用业务表、不升级依赖。

**目标：** 已有记录的修改、删除使用修改前 G 与角色条件的交集，并在实际写事务中锁定、整批验证；历史数据允许首次编辑时原子认领，不能直接删除。

**架构：** `AccessMutationService` 复用统一查询服务。`authorizeExisting` 只在调用者实际事务内生成写计划；`withExistingRecords` 为服务器适配器提供拥有完整事务的执行入口。写入回调来自服务器代码，负责现有 Repository、角色字段权限及业务 Hook；不能由 HTTP 参数提供。首阶段只支持根字段更新，关联外键和嵌套关系修改明确拒绝，避免将根权限误当作目标权限。

**文件：** `access-control/mutation.ts`、`mutation-errors.ts`、`context.ts`；`__tests__/access-control/mutation.test.ts`。

## 1. 事务与 G

- [x] 写失败测试：V 可读不可写；请求值不能让无权旧记录获得 G；显式多个目标只要一个无权即整体失败。
- [x] 用单字段主键定位，数据库内按主键稳定顺序锁定全部目标，随后同事务查询 G 与服务器提供的角色条件交集。授权结果不依赖请求中传入的旧记录对象。
- [x] 授权条件涉及关联存在或租户层级时，PostgreSQL 使用 SERIALIZABLE；根字段条件保持默认事务加行锁。SQLite 只开放根字段写入，以 IMMEDIATE 事务执行；关系型写入尚未验证时明确拒绝。
- [x] 调用者已有事务必须来自同一个数据库、仍有效、可写，关系规则不能使用隔离级别不足的事务；无事务直接拒绝。串行化冲突不自动重试业务写入。

## 2. 历史认领和归属不变

- [x] 写失败测试：G 授权历史首次编辑后属于当前租户；V 历史只读；有 G 的未归属记录仍不能直接删除；共享无归属字段表不认领。
- [x] 当前租户从可信身份解析且在同一事务验证启用。认领只把 null 改为当前租户，已归属记录不转移；请求中冲突 tenantId 拒绝。
- [x] 根字段写入回调只在整批授权完成后执行，业务失败回滚认领。状态更新后可离开 G，不回读完整业务对象导致误报失败。
- [x] 验证归属不变约束：回调或 Hook 改写到不允许的 tenantId 时回滚；无归属字段管理的表保持普通写语义。

## 3. 并发与复核

- [x] 在独立 PostgreSQL 中运行实际服务，验证同时认领只成功一位；关联撤权先提交后新写拒绝；构造正向/否定关系及租户层级并发冲突，整体回滚。
- [x] 验证正常数据库锁和查询次数不随授权目标逐条增长，授权不加载全部关联 ID。
- [x] 运行相关测试、类型、格式、lint 和 module-tenant 构建；独立审查并修正有效意见，清理测试库。

实际验证：写入服务在 SQLite 执行 36 项、独立 PostgreSQL 执行 42 项，共 78 项通过。联合规则、配置、ACL、根查询及旧过滤/认领回归，共 14 个文件、323 项通过，无跳过。独立测试库已删除；模块构建、严格类型检查、oxlint 和 Prettier 通过。

并发认领测试先确认第二条 PostgreSQL 连接正在等待根行锁，再允许第一位提交；只执行第一位的写回调。正向关联、否定关联和租户层级的冲突均通过实际服务执行，回滚后不发 `afterCommit` 通知。单条与 20 条目标的根授权查询均为 2 次。

独立审查的两项意见已用失败测试确认并修复：不依赖租户的共享规则不额外校验无关租户；发布授权计划及完成写入时核对当前注册 Collection、Model 和稳定标识。归属检查读取数据库原始字段，不使用展示 getter；根删除拒绝尚未适配的 CASCADE、SET NULL 等关联写入。复审未发现新的具体问题。

角色或请求条件包含无法证明只读根字段的 Sequelize 表达式时，也按可能依赖关联处理，要求 PostgreSQL 串行化事务。保留原 SQL 和命名绑定，不解析或改写 SQL 文本。

`authorizeExisting` 仅提供事务内授权原语，不负责调用者后续写入的提交、回滚或归属复核。当前完整根写入口是 `withExistingRecords`；需要沿用工作流外层事务的入口，应在后续适配中复用同等的写后验证，不能直接取得计划后跳过它。

内部调用示例：

```typescript
await mutations.withExistingRecords(ctx, tableIdentity, authenticatedIdentity, {
  operation: 'update',
  keys: requestedKeys,
  values: sanitizedRoleValues,
  where: parsedRoleAndRequestWhere,
}, async (plan) => {
  for (const record of plan.records) {
    await record.update(plan.valuesFor(record), { transaction: plan.transaction });
  }
});
```

仅支持根字段的回调仍须沿用业务 Repository 或既有写协议；示例不代表可以绕过角色权限。新增候选记录见 [新增记录保护](2026-10-13-tenant-access-control-create.md)。关系操作、筛选式批量接口、级联写入、通知及业务运行入口仍由各自适配阶段完成，不能据本阶段启用新模型。

后续 [单值关联阶段](2026-10-13-tenant-access-control-reference.md) 增加 `authorizeReferenceSource`，复用根锁及 G 校验，只产生服务端历史认领补丁，不放宽普通更新接口。完整根更新也增加写前、写后受保护关联字段核对，阻止业务 Hook 隐式改变外键。启用归属管理时，`tenantId` 始终由精确归属核验负责，即使它本身关联租户表，合法历史认领仍可完成。
