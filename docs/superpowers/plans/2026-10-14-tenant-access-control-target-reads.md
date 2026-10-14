# 一对多和一对一关联读取实现计划

沿用已批准的访问模型，使用 writing-plans、executing-plans 和 test-driven-development 完成本阶段。留在 `feat/tenant-access-control`，验证后签名原子提交，不升级依赖、不接入业务入口、不修改业务库或线上。

## 范围与接口

新增 `access-control/target-foreign-key-reads.ts`，提供 `AccessTargetForeignKeyReadService.scopeTargets(ctx, source, target, authenticated, request)`。返回 `ScopedAccessQuery`，供目标表列表、详情、计数复用；只接受已注册的 HasMany/HasOne、同库不同模型、单主键关系。多对多读取及批量展开在另一阶段实现。

请求包含 `association`、`sourceKey`、可选 `targetKey`、来源和目标各自的 `Where`/`Bind`，以及可选事务。正常路径先检查来源 ACL 条件与 G 或 V，再将实际目标外键、关联 scope、目标 ACL 条件与目标 G 或 V 取交集。`sourceKey: '_'` 遵循核心直接目标读取协议，不查询虚构来源；目标条件及关联 scope 仍生效。入口适配器仍负责操作及字段 ACL。

读取只生成条件，不收集全部目标 ID、不使用扩增结果的 JOIN、不写入或认领历史数据。事务保持原对象；其余输入在等待前复制。关联、配置或模型身份在异步授权期间变化时拒绝返回过期计划。

## 实施步骤

- [x] 新增 `__tests__/access-control/target-foreign-key-reads.test.ts`。用真实模型证明关联返回目标 G/V 的交集；先运行并确认缺失能力导致红灯。
- [x] 在 `target-foreign-key-metadata.ts` 增加默认保持写入校验的读取选项；读取允许并快照关联 scope，不执行仅写入所需的外键副作用检查。
- [x] 实现读取服务；目标外键直接使用 `where` 与范围相交，来源缺失或不可读时报统一不可访问错误。
- [x] 覆盖 HasMany/HasOne、来源只读/隐藏/缺失、目标隐藏/历史、独立 ACL、命名绑定、空结果、分页/数量/汇总、占位符、scope、事务、输入快照、身份变化和错误关系。
- [x] 运行新测试及 HasMany/HasOne 写入回归；严格类型检查、oxlint、Prettier、租户包构建；独立复审未发现问题，更新本计划与规格后单独签名提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-reads.test.ts --reporter=default`。SQLite 验证读取；通过严格命名的独立本地 PostgreSQL 测试库复核真实 SQL。联合回归同时包含 `has-many.test.ts` 和 `has-one.test.ts`，共用独立测试库时必须附加 `--maxWorkers=1 --no-file-parallelism`，避免各文件的建表和清表互相干扰；测试库结束精确删除。

## 验证结果

- 先确认缺失模块，再以未实现服务得到真实行为红灯；实现后测试转绿。
- SQLite 与 PostgreSQL 各 28 项读取测试通过，共 56 项。
- 读取加 HasMany/HasOne 写入联合回归：3 个文件、144 项全部通过，无跳过。
- 来源与目标权限查询次数不随关联目标数增加；样例从 3 条增至 53 条，授权和目标查询仍不超过 4 次。这不是批量展开或真实业务页面的性能验收。
- 新服务与共享元数据文件的严格 TypeScript 检查通过，其他模块使用其已构建公共类型；3 个变更代码与测试文件 oxlint 无警告、无错误，Prettier 和差异空白检查通过。
- `pnpm exec tegod build @tachybase/module-tenant` 构建成功；独立审查未发现具体问题。

独立测试库均已精确删除。新服务没有安装全局关联拦截器，没有修改已有资源的行为；未改业务数据或线上。多对多读取、批量展开、关联筛选排序、业务入口及配置界面仍需继续实施。
