# 租户访问模型：单值关联读取与引用

> 在 `feat/tenant-access-control` 内联使用 writing-plans、executing-plans、test-driven-development 和 requesting-code-review，验证后按职责提交。保留已有修改，不推送、不升级依赖、不修改业务数据库或线上配置。

**目标：** 单值外键修改按来源 G、目标 G 或 V 检查；读取关联时分别应用来源和目标角色条件。引用历史目标不认领，修改历史来源沿用原子认领。

**架构：** 使用现有真实模型、主库配置快照、根查询和写入授权服务。新增内部单值关联服务，不挂全局查询/关联预加载拦截，不注册业务入口。真正设置关系仍调用原 Repository，写后核对归属和实际外键。关系写入首版仅支持 PostgreSQL SERIALIZABLE；SQLite 可做读取与引用范围单测，关系写入明确拒绝。

## 文件及契约

- `access-control/association-metadata.ts`：核对同数据源、当前注册的来源/目标 Collection 与 Model、BelongsTo 类型、外键和单主键目标；关联或模型变更立即失效。
- `access-control/references.ts`：`authorizeTargets(ctx, target, identity, {keys, where?, bind?}, transaction?)` 批量检查目标 G 或 V 与角色条件，返回原始字段读取的 Model；不写目标、不认领。
- 同文件 `scopeBelongsToTarget(ctx, source, target, identity, {association, sourceKey, targetKey?, sourceWhere?, sourceBind?, targetWhere?, targetBind?, transaction?})`：普通来源先检查可读，再把实际外键与目标范围相交；`sourceKey='_'` 只跳过来源记录检查，必须提供明确目标键，目标过滤保留。无外键得到空范围。
- `access-control/belongs-to.ts`：`withReference(ctx, source, target, identity, {association, sourceKeys, targetKey, sourceWhere?, sourceBind?, targetWhere?, targetBind?}, writer)`，同事务授权来源、目标，可信回调收到原来源 Model、实际事务及 `valuesFor`。写后核对指定来源的归属、实际外键和其他受保护关联字段，不要求修改后继续命中 G。
- `access-control/mutation.ts`：新增内部 `authorizeReferenceSource`，复用现有根锁、G/角色条件及认领逻辑，只产生归属补丁；现有普通更新仍拒绝空字段和外键输入。
- `__tests__/access-control/reference.test.ts`：独立 SQLite / PostgreSQL 表，覆盖所有以下断言。

## 1. 先写失败测试，再实现读取与引用

- [x] 新增测试和最小空壳，运行确认失败原因是服务未实现。
- [x] 验证目标仅 V 可引用；隐藏或角色不允许的目标拒绝；历史目标 tenantId 不变；多个明确目标有一个无权则整批拒绝。
- [x] 验证关联可读来源的隐藏目标不会被返回；SQL 查询使用实际原始外键，展示 getter 不能改变目标；`/_/` 仍检查目标范围。
- [x] 验证同名其他数据源、错误目标、未准备配置、替换的关联、非 BelongsTo、非主键目标均拒绝；沿用统一查询服务的 Collection/Model 注册身份检查。

运行：

```powershell
cmd /d /c pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/reference.test.ts --no-file-parallelism --reporter=default
```

## 2. 单值外键修改

- [x] 给已有根授权增加独立的来源引用入口，普通更新接口不放宽。
- [x] 验证来源仅 V 不可写；来源 G 可引用目标 V；历史来源首次成功修改认领，目标历史记录不认领；清空外键无需读取旧目标。
- [x] 验证伪造归属、Hook 改错外键、批量某个来源无权、回调抛错和关联替换全部回滚；afterCommit 不发。
- [x] 验证合法关系变化可使来源退出 G，仍返回最小成功结果。
- [x] 运行真实 PostgreSQL 并发撤权和引用修改交错，覆盖 SERIALIZABLE 冲突映射且不自动重跑回调；观察数据及提交后通知。

调用示例：

```typescript
await links.withReference(ctx, sourceTable, targetTable, authenticated, {
  association: 'project',
  sourceKeys: selectedKeys,
  targetKey: selectedProject,
  sourceWhere: parsedSourceRoleWhere,
  targetWhere: parsedTargetReadRoleWhere,
}, async (plan) => {
  for (const record of plan.records) {
    await sourceRepository.update({
      filterByTk: record.getDataValue(sourcePrimary),
      values: plan.valuesFor(record),
      transaction: plan.transaction,
    });
  }
});
```

入口仍须先验证角色操作和外键字段权限，where 是服务器解析的角色条件，不接收客户端授权计划。只支持修改已存在的来源记录；新增含关联、HasMany/HasOne、普通多对多、有业务字段的中间表、跨数据源、嵌套目标写入由各自适配器处理，本阶段不冒充支持。

关系写入同事务锁定来源行和目标行（UPDATE / SHARE），目标校验包含 G 或 V、目标角色条件、默认模型范围及关联自身范围。单独调用 `authorizeTargets` 不写数据；传入事务用于写入授权时，要求真实的 PostgreSQL 可写 SERIALIZABLE 事务。关联读取保留调用方读事务。

独立审查发现并用 PostgreSQL 失败测试确认：业务 Hook 可改动当前授权外键以外的关联字段。现由公共 `snapshotProtectedValues` 在关联修改和普通根更新中快照这些字段，写后核对，失败整批回滚；不会按修改后的 G 再次读取完整对象。同一个外键同时影响不兼容关系时，也明确拒绝写入。

归属字段 `tenantId` 可能本身也是租户表外键。只有服务器配置启用归属管理时，该字段才交由已有精确归属校验处理，不作为普通关联字段禁止变化；新增注入和历史认领可正常完成，其他租户 ID 仍不能被写入。SQLite / PostgreSQL 的根编辑和新增，以及 PostgreSQL 的单值关联认领均有回归用例。

## 3. 复核

- [x] 运行新测试与全部已有访问模型回归，使用严格命名的独立 localhost PostgreSQL 库，结束删除。
- [x] 验证严格类型、oxlint、Prettier、module-tenant 构建；独立审查并修复仍有效的问题。
- [x] 更新本计划及设计文档，明确未注册业务入口及未支持的关系操作。

实际结果：新增 58 项回归（SQLite 19 项、PostgreSQL 39 项），联合规则、配置、ACL、根读写和旧过滤/认领回归共 16 个文件、459 项全部通过，无跳过。严格运行时代码类型检查、oxlint、Prettier 和 module-tenant 构建通过。独立审查的 Hook 隐式改外键、归属字段为真实外键两项意见均先用失败测试确认，再修复复核；未发现新的具体阻塞问题。

所有 PostgreSQL 验证使用独立 localhost 测试库，运行后删除；未改业务数据库、线上配置或依赖。当前仍未注册实际请求入口。其余关联类型、关联展开及关联筛选排序、业务入口和管理页面需要后续适配，不能据这些内部测试启用业务表的新模型。
