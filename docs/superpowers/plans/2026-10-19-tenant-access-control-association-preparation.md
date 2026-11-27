# 具体来源关联读取的异步权限准备

延续已批准的归属性和可见性设计，为内部关联读取补齐异步授权。不注册路由，不切换现有业务表，不修改核心或依赖。

涉及文件：`association-read-contexts.ts` 负责元数据路径规划及异步准备；`root-read-handler.ts` 增加 `handleAssociationWithRelatedContexts`，与同步入口复用已捕获的来源、目标权限和执行逻辑；`related-read-contexts.ts` 在原解析函数上附加 `assertCurrent`，用于执行后检查嵌套关联；两个关联数据库测试文件验证实际数据；设计文档记录本阶段边界。

- [x] 在 `target-foreign-key-reads.test.ts` 和 `many-to-many-reads.test.ts` 增加 `asynchronous association preparation` 用例，先运行确认新入口缺失时失败。
- [x] 元数据规划从实际目标表开始，获取字段展开、筛选和排序所需路径，再加回原始关联前缀。get 的目标定位已由已有捕获函数校验，规划阶段仅检查字段和筛选，不执行查询。
- [x] 调用已有 `prepareRelatedReadContexts`，以实际来源身份和本次 get/list/count 操作准备上下文。第一跳目标已有最终操作权限，不额外要求其中性 list 权限；中间表及更深层路径逐一等待调用者的既有授权流程。
- [x] 来源、目标、请求、身份和日期在回调前捕获；每次异步前后检查原始关联及准备阶段，执行后再次检查，失败保留原响应。同步入口继续使用原解析器。
- [x] 验证嵌套字段、关联筛选、排序、中间表、重复记录计数、单值详情、缺失或拒绝授权、身份快照、生命周期失效、事务及同步入口回归。
- [x] 运行聚焦 SQLite/PostgreSQL 测试、严格类型、lint、格式及租户模块构建；独立审查未发现待修问题。

聚焦命令：

```powershell
pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-reads.test.ts packages/module-tenant/src/server/__tests__/access-control/many-to-many-reads.test.ts -t 'asynchronous association preparation' --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism
pnpm exec tegod build @tachybase/module-tenant
```

双数据库在独立 PostgreSQL 测试库中运行上述两个文件及 `related-read-contexts.test.ts`；执行后删除测试库。业务接入和新模型启用留在后续独立阶段。

验证结果（2026-10-19）：

- 实现前首批 22 个新增用例因新入口缺失而失败；实现后 23 个新增 SQLite 用例全部通过，包括执行后嵌套关系变更检查。
- SQLite/PostgreSQL 关联读取及授权准备回归：3 个文件、562 个测试通过。独立 PostgreSQL 测试库已删除。
- `reads.test.ts` 的普通异步读取、占位读取和图表相关回归：111 个测试通过，260 个无关用例跳过。
- 严格 TypeScript 检查 0 个诊断；五个变更 TypeScript 文件的 oxlint、Prettier 通过；租户模块构建成功。
- 独立审查确认来源、目标、中间表及嵌套授权保持独立，操作路径绑定、单值详情和同步入口行为未发现回归。
