# 租户访问模型：普通多对多连接写入

> 使用 writing-plans、executing-plans、test-driven-development 和 requesting-code-review，在现有功能分支内完成，验证后按职责提交。保留已有修改，不推送、不升级依赖、不修改业务数据库。

**目标：** 多对多增、删、替换连接按来源 G 和明确目标 G 或 V 授权；历史目标不认领，历史来源只在连接实际变化时认领。

**架构：** 使用现有配置快照、根授权和目标引用服务。事务内计算连接差集，再通过真实 RelationRepository 写入；写后检查实际连接、来源归属和受保护字段。仅支持 PostgreSQL SERIALIZABLE、同数据源、单主键和纯连接表。中间表包含业务字段、归属或条件范围时明确拒绝，不能套用普通连接权限。

## 文件与接口

- `access-control/many-to-many-metadata.ts`：核对当前注册的来源、目标、关联和中间模型；限定来源/目标主键、普通连接字段和稳定元数据。
- `access-control/many-to-many.ts`：`withLinks(ctx, source, target, throughIdentity, authenticated, {association, operation, sourceKeys, targetKeys, sourceWhere?, sourceBind?, targetWhere?, targetBind?})`，返回最小结果 `{keys, affected}`。`operation` 仅 `add`、`remove`、`set`；内部执行 Repository，不接收客户端计划或中间字段。
- `access-control/join-write-guard.ts`：仅在当前异步写入期间检查真实 bulk 输入和数据库写入路径，防止 Hook 扩大连接范围、替换事务或夹带单条连接写入。结束时移除临时 Hook。
- `__tests__/access-control/many-to-many.test.ts`：真实 PostgreSQL 集成测试；SQLite 只验证关系写入被拒绝。

入口适配器仍须验证来源操作权限、关联字段权限、目标引用操作权限；where/bind 是服务端解析的角色与请求条件。明确传入的目标都需要可读；`set` 隐式移除的旧目标无需再次读取，因为不修改目标。不存在连接的删除及保持原样的替换不写来源，不认领历史数据。目标编辑和删除不属于此接口。

来源、目标和连接表都必须先加载主库权威配置快照。连接表有独立访问模型时拒绝此接口，不能因其只有两个连接字段就绕过自身规则。来源与目标必须是不同模型；同一连接键不能同时表示不兼容的业务关系。

删除连接可能通过 `CASCADE`、`SET NULL` 等规则写入其他记录时，当前接口明确拒绝，待相关对象的写入适配完成后再开放；没有删除差集的新增和替换仍可使用。每个来源和目标批次最多 1000 项，候选连接及当前已有连接最多 10000 项。

Hook 保护针对当前操作通过 ORM 发出的连接表写入，不承诺拦截可信代码刻意执行的裸 SQL 或其他表副作用。业务 Hook 额外写入需使用相应适配器；外部通知应放在事务提交后。

## 实施与验证

- [x] 写失败测试：来源 G 可关联目标 V；隐藏目标、来源仅 V、角色条件不满足整批拒绝。
- [x] 运行失败测试，确认尚无多对多写入服务；实现最少授权与真实 Repository 写入。
- [x] 验证 add/remove/set、去重和空 set；目标历史归属不变；来源只在实际变化时认领；批量中一个对象无权全部回滚。
- [x] 验证修改前 G 授权、写后合法退出 G；隐藏旧目标可被 set 隐式解绑。
- [x] 验证业务中间表、归属字段、非主键关系、同名其他数据源、未准备配置和元数据替换全部拒绝。
- [x] 验证 Hook 写错连接、改变来源归属或第二个外键时回滚；回滚不触发 afterCommit。
- [x] 使用真实 PostgreSQL 并发验证 SERIALIZABLE 冲突返回 409，不自动重试写入。
- [x] 运行聚焦测试和访问模型联合回归、严格类型检查、oxlint、Prettier 和 module-tenant 构建；独立审查。
- [x] 更新设计和验证结果。HasMany、带业务字段中间表、其余关联读写和业务入口继续保持未启用。

聚焦命令（测试环境由严格命名的独立 localhost PostgreSQL 库提供，结束精确删除）：

```powershell
cmd /d /c pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/many-to-many.test.ts --no-file-parallelism --reporter=default
```

## 验证结果

2026-10-13，稳定代码上的联合回归共 17 个文件、505 项测试，全部通过，无跳过。包含本阶段 46 项测试（PostgreSQL 45 项、SQLite 拒绝未验证方言 1 项），以及先前规则、配置、ACL、查询、新增、修改、引用、旧租户过滤和历史认领测试。

严格 TypeScript 检查、修改的 4 个代码文件 oxlint、代码及文档 Prettier 检查、`@tachybase/module-tenant` 构建均通过。独立审查指出的空删除差集误拒绝已修复并复核；危险级联删除使用真实连接主键及非空引用完成红绿验证。

该结果验证的是本阶段的内部服务。业务入口、HasMany、业务中间表和真实业务性能在本阶段尚未验收，不能据此为业务表开启新模型。两仓保持 `feat/tenant-access-control` 分支，未升级依赖、未修改业务数据或线上配置；后续进展见设计文档。
