# 租户访问模型：新增记录保护

> 在 `feat/tenant-access-control` 使用 writing-plans、executing-plans 和 test-driven-development 完成，验证后按职责提交。不启用业务表、不升级依赖、不写业务数据库。

**目标：** 新增记录只通过 G 授权，归属由可信当前租户设置；校验数据库最终写入值，失败整批回滚。

**架构：** `AccessCreationService.withCreatedRecords` 拥有完整写事务，向可信服务器写回调提供规范化后的根字段数组和实际事务。回调沿用 Repository 与业务 Hook，返回实际创建的 Model。服务对未提交的新记录复用根查询服务检查 G、角色条件和实际归属，再返回最小结果。事务内事件只能产生同事务写入，外部通知必须使用 afterCommit；完整业务入口接入前不注册此服务。

## 1. 共用写入约束

- [x] 创建 `access-control/write-support.ts`，从 `mutation.ts` 提取输入快照、根字段验证、关系依赖识别和实际事务校验，保持已有修改/删除行为不变。
- [x] 新增允许单字段主键输入，但拒绝外键、关联键、嵌套关系、虚拟字段及未知字段；这些写入需要关系适配器。

## 2. 新增与归属

- [x] 创建 `__tests__/access-control/creation.test.ts`，先验证 V 不授权新增、G 拒绝时回滚、批量一项失败整批回滚、当前租户注入及伪造归属拒绝。
- [x] 创建 `access-control/creation.ts`，实现 `withCreatedRecords(ctx, identity, authenticated, {values, where?, bind?}, writer)`；values 是 1–1000 个已按角色字段权限过滤的根字段对象。
- [x] 归属管理启用时，验证当前租户并将遗漏/null 归属设置为当前租户；其他租户值拒绝。共享表不依赖无关租户，规则需要的上下文照常检查。
- [x] 回调返回的 Model 必须来自目标表、已经保存、主键有效且互不重复；绑定实际 INSERT 结果，再按不可变主键整批查询 G 与角色条件交集，不使用请求值或被 Hook 改写的返回主键冒充保存结果。
- [x] 验证默认值、Hook 改写、SQL NULL/NOT 语义、角色过滤、返回最小结果、原始异常及 afterCommit 回滚行为。

## 3. 事务、并发和复核

- [x] 根字段规则采用正常写事务；G、角色条件依赖关系时采用 PostgreSQL SERIALIZABLE，SQLite 对尚未支持的关系写入拒绝。
- [x] 写后核对同一配置阶段、注册表/模型稳定标识及实际归属，任何变化均回滚；串行化冲突返回可重试错误，不自动重跑业务回调。
- [x] 在独立 PostgreSQL 测试库运行实际服务，覆盖关联撤权及否定存在冲突；测试库验证后删除。
- [x] 运行新增与已有写入回归、联合访问模型测试、严格类型、格式、lint 和租户模块构建，并完成独立审查。

实际验证：新增服务 SQLite 37 项、独立 PostgreSQL 41 项，共 78 项通过。包含规则、配置、ACL、根查询、已有写入及旧过滤/认领的联合回归共 15 个文件、401 项全部通过，无跳过。严格运行时代码类型检查、oxlint、Prettier 和 module-tenant 构建通过。独立审查中的有效意见均先用失败测试确认，再修复并复审；独立测试库已删除。

调用示例：

```typescript
await creations.withCreatedRecords(ctx, tableIdentity, authenticatedIdentity, {
  values: sanitizedRoleValues,
  where: parsedRoleConditions,
}, async (plan) => {
  const created = [];
  for (const values of plan.values) {
    created.push(await repository.create({ values, transaction: plan.transaction }));
  }
  return created;
});
```

回调只能由服务器适配器提供，不能接受客户端脚本；它负责实际新增，不允许将已有对象或其他表对象冒充创建结果。当前不支持嵌套明细、外键引用、筛选式批量及跨数据源事务；需要这些能力的入口在对应适配完成前不能启用新模型。

## 4. 审查补充与使用边界

独立审查发现，`afterCreate` 只改返回对象的主键时，原实现可能检查到另一条有权旧记录。显式主键与数据库生成主键均已用失败测试复现，并绑定实际 INSERT 结果修复。服务只在本次写事务期间挂临时 `afterQuery` 观察器，限定事务及目标模型，记录主键；结束或异常时都移除，不修改 SQL、查询条件或现有关联加载。超限及重复 INSERT 只记录失败状态，避免覆盖原始数据库错误。

默认值或 `beforeCreate` 隐式设置外键也会真实建立关联。除请求字段检查外，写后额外读取受保护的物理列，非空关联键、外键及引用字段均拒绝，待关系适配器完成后开放。普通主键作为关系来源键不因此禁止新增；主键本身是引用字段仍拒绝。

SQLite 会让自动生成的主键经过业务 setter，观察器取得的主键可能已经失真。本阶段明确拒绝 SQLite 自增主键带自定义 setter 的模型；普通生成主键及展示 getter 可用。PostgreSQL 的插入返回值直接写入原始字段，已通过真实数据库验证。

可信回调须对每条 `plan.values` 在 `plan.transaction` 中执行一次普通 Repository 创建，返回全部实际 Model。已有 Model、其他表对象、重复对象、未保存对象、缺少 INSERT 来源或额外插入目标记录都拒绝。不支持未产生单条插入来源的 `bulkCreate`、原始 INSERT 或跨事务创建。

服务不会自动撤销第三方 Hook 已即时发出的网络请求或通知。当前入口尚未注册；实际接入前必须把外部副作用移到提交后，或使用同事务消息记录。新增失败整批回滚，`afterCommit` 不运行；成功仅返回主键及数量，不要求创建者再次满足完整回读权限。
