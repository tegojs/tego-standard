# 具体来源关联读取的最终权限组装

目标：新增内部 `AccessRootReadHandler.handleAssociation`，支持既有单跳具体来源的 get/list/count 协议；没有业务路由切换。

来源使用调用者提供、已走完服务器 ACL 的中性来源 list 上下文，目标使用本次关联请求的最终操作权限。来源必须允许访问关联字段；实际来源记录、目标记录和多对多中间记录分别应用角色条件及 G/V。更深层关联和中间表通过既有同步上下文解析器提供中性 list 权限，不能借用目标的本次操作权限。异步权限路径准备不在本批次加入。

涉及文件：`root-read-context.ts` 捕获并绑定关联协议；`root-read-handler.ts` 组装来源和目标权限并调用已有 `fromResource`；`target-foreign-key-reads.test.ts` 与 `many-to-many-reads.test.ts` 验证实际数据库；共享 `finalized-read-context.ts` 仅供测试构造真实核心 ACL 决策。

- [x] 在单对多测试夹具增加成功、拒绝和嵌套读取用例，运行确认缺少新方法时失败。
- [x] 捕获来源和目标决策、参数、身份及日期后才调用集合身份解析器；严格核对动作、原始路径元数据和实际目标集合。
- [x] 区分单值关联无目标 key 与多值关联必须提供目标 key，保留 REST 定位匹配校验；`/_/` 留给已有独立入口。
- [x] 复用已有关联读取，检查成员关系和每个实际读取对象的权限；不增加权限 JOIN 或加载所有关联 ID。
- [x] 补多对多去重、中间表限制、路径字段限制、事务、身份快照和关系生命周期用例。
- [x] 运行 SQLite/PostgreSQL 相关回归、严格类型、lint、格式和租户模块构建；独立审查未发现待修问题。

验收：来源隐藏或无来源操作权限时拒绝；来源可见和历史只读记录可引用，不认领；目标隐藏时不返回；通过不同名称的关联字段仍绑定实际目标集合。目标字段和数据范围与来源路径字段限制相交。重复中间记录不重复分页或计数。错误权限、非中性来源/中间表请求及缺少目标定位在 SQL 前拒绝；执行中关系或准备阶段失效不发布响应。

验证记录（2026-10-19）：

- 新方法实现前，首批 19 个聚焦用例按预期失败；实现后的 SQLite 新增聚焦用例 40 个通过。
- SQLite/PostgreSQL 回归覆盖 `target-foreign-key-reads`、`many-to-many-reads`、`reads`、`resource-read-params`、`resource-read-routing` 五个测试文件，1384 个测试全部通过。测试使用独立 PostgreSQL 数据库，结束后已确认删除。
- 严格 TypeScript 检查 0 个诊断；五个变更 TypeScript 文件的 oxlint 与 Prettier 检查通过。
- `pnpm exec tegod build @tachybase/module-tenant` 成功；独立审查未发现需要修改的正确性或权限边界问题。

后续仍需补齐中间表和嵌套关联的异步权限路径准备，再按设计推进业务入口接入；本批仅交付内部组装能力。
