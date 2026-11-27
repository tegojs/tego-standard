# 新增记录时选择已有的多选关联

延续已批准的 G/V 模型，在内部根新增入口同时保存普通字段、BelongsTo
主键/null、BelongsToMany 主键数组，两类关联合计最多 20 个。不注册业务路由。

## 实现与验证

- [x] 在 `link-creation-handler.test.ts` 使用真实 ACL、Repository 和隔离的
  PostgreSQL 数据库，先证明混合新增因当前仅支持 BelongsTo 而失败。
- [x] `creation-reference.ts` 同步捕获所有关联类型、目标/中间表身份、主键及元数据；
  每个非空字段独立取得最终中性 list 权限和可读主键。空数组仅跳过目标授权。
- [x] `root-mutation-handler.ts` 在克隆原始请求前拒绝自定义原型关联数组，
  将可信的单选及多选授权计划交给新增服务，不把关联值传给普通字段写入。
- [x] `creation-links.ts` 复用纯中间表解析、目标 G/V 检查、关系 scope 和连接写保护；
  所有目标在 INSERT 前授权，来源 INSERT 回执核实后再写连接，最后精确核对连接集合。
- [x] `creation.ts` 继续使用同一个 PostgreSQL 串行化事务和 INSERT 回执；
  连接保存后才检查实际来源的 G、角色条件、外键和归属。保留旧单选和普通新增契约。
- [x] 覆盖目标权限/字段/角色/GV/scope、来源 G、历史目标、不合法数组、合计数量限制、
  元数据变化、钩子失败及整笔回滚（包括 afterCommit 通知）。
- [x] 运行新增及旧新增、引用、连接回归；执行 tenant 构建、聚焦 lint/格式检查；
  独立只读审查后修正有效问题，更新设计，使用默认签名作一次英文原子提交。

验证命令：`node C:/Users/TomyJan/AppData/Local/Temp/tego-access-reference-runner.cjs link-creation-handler.test.ts reference-creation-handler.test.ts creation.test.ts root-creation-handler.test.ts reference.test.ts many-to-many.test.ts root-mutation-handler.test.ts`。
运行器创建并删除随机专用测试库，不使用业务库。

## 审查与证据

- 初始混合新增用例因旧入口仅支持 BelongsTo 而失败，扩展后通过。
- 审查发现普通 JSON 数组误用关系键数量限制，以及连接钩子可在 INSERT 观察器移除后
  额外新增来源记录。两项均补充失败用例再修复：仅对实际多对多字段验证原数组；
  INSERT 观察器保留到连接及最终校验结束，再核对回执，并始终在 finally 移除。
- 新增套件通过 70 项，28 项按数据库能力跳过；覆盖纯普通字段 JSON 兼容性、
  20/21 个混合关联、关系条件在新增连接后判定、钩子额外单条/批量 INSERT 回滚，
  提交后通知不触发以及观察器清理。独立复核未发现剩余阻塞问题。
- tenant 包构建、聚焦 oxlint 和 Prettier 检查通过。
- 最终回归：7 个文件通过，497 项通过，73 项按数据库能力跳过，共 570 项。
  专用 PostgreSQL 测试库已清理，未修改业务库、依赖或业务入口。
