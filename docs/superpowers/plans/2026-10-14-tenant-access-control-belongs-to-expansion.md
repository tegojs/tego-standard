# 单值关联批量展开实现计划

> 沿用已批准设计，使用 executing-plans 在 `feat/tenant-access-control` 逐步实施并签名提交。

**目标：** 一页可读来源记录展开 BelongsTo 关联时，隐藏目标返回 `null`、根记录不丢失，查询次数不随页内条数增加。

**架构：** 新增内部 `AccessBelongsToExpansionService`，复用已登记关联元数据与 `AccessQueryService`。一次检查显式来源页（最多 1000 个主键），一次查询其去重后的目标主键；这是有限页的外键展开，不扫描全表或预加载全部权限关联 ID。目标 G/V 和 ACL 在数据库内过滤，结果只投影入口已授权的物理字段。

**技术栈：** TypeScript、Sequelize、Vitest、SQLite、独立 PostgreSQL 测试库。

## 接口与约束

创建 `packages/module-tenant/src/server/access-control/belongs-to-expansion.ts`，提供：

```ts
load(ctx, sourceIdentity, targetIdentity, authenticated, {
  association: 'project',
  sourceKeys: [1, 2],
  targetAttributes: ['name'],
  sourceWhere, sourceBind, targetWhere, targetBind, transaction,
});
// ReadonlyMap<string, Readonly<Record<string, unknown>> | null>
```

结果按规范化后的来源主键映射；空外键、目标不存在、目标不可读都返回 `null`。来源页中有不存在或不可读项时整体拒绝，不能借展开读取未授权来源的外键。重复主键去重并保持请求顺序；空页返回空映射。显式批量键不使用 `/_/` 协议；直接目标读取继续由已有单值读取服务处理。

入口仍负责操作、关联字段及目标字段 ACL，必须传入已授权字段和分别解析的来源/目标数据条件。目标用于配对的主键只在内部读取，未选择就不返回；不返回来源外键、隐藏字段或虚拟 getter。共享目标需显式共享配置，不能因来源隔离而注入 `tenantId`。本阶段只支持两表都已迁移的同库单主键关联，未迁移表拒绝；未来业务入口负责旧机制的适配。

输入在异步前复制，真实事务不复制。每次异步读取后检查配置、模型、关联及默认范围/物理列快照；不写数据、不认领历史数据，不安装全局关联拦截器。

## 实施与验证

- [x] 创建 `packages/module-tenant/src/server/__tests__/access-control/belongs-to-expansion.test.ts`，先确认缺失能力失败。
- [x] 创建服务并验证来源/目标各自 G/V/ACL、隐藏目标保留根项、重复目标、空页及空关联、明确字段投影、同库自关联、scope、默认范围和软删除。
- [x] 验证活跃/已结束/外库事务、配置与模型失效、输入快照、错误字段和超大页拒绝，20 与 100 条页的权限 SQL 次数相同。
- [x] 在 SQLite 与随机独立 PostgreSQL 数据库串行运行新文件和 `reference.test.ts`：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/belongs-to-expansion.test.ts packages/module-tenant/src/server/__tests__/access-control/reference.test.ts --maxWorkers=1 --no-file-parallelism`。
- [ ] 严格运行时类型检查、oxlint、Prettier、module-tenant 构建与独立代码复审，更新规格，签名原子提交。

多值关联批量展开、跨关联筛选排序、配置界面与业务入口启用不属于本阶段。不得修改本地业务库、线上配置、依赖或核心仓库。

## 验证结果

新增测试在 SQLite 和独立 PostgreSQL 测试库各通过 43 项，关联引用回归通过 58 项，共 144 项；独立测试库已删除。共享无 `tenantId` 目标、SQL 内关系可见性、默认范围/软删除、字段投影、真实事务和查询期间配置/关联/列变化均有断言。20 条与 100 条来源在两种数据库下 SQL 次数一致且最多 4 次。`module-tenant` 构建、严格运行时 TypeScript 与 oxlint 均通过。
