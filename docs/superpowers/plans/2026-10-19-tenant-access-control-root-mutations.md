# 普通记录修改和删除的最终权限接入

沿用已确认的访问控制设计，在当前功能分支使用 executing-plans 和 test-driven-development 实施。只增加内部入口，不注册业务路由，不升级依赖。

目标：核心已完成的操作权限、字段限制及角色范围，与现有事务写入服务的归属性 G 取交集。可见性 V 不授予写权限。成功返回最小结果，不因写后退出原范围而误报失败。

文件职责：

- `access-control/final-action-permission.ts`：提取现有最终读取权限捕获的通用部分；原读取函数保留兼容导出。
- `access-control/root-mutation-handler.ts`：捕获根 update/destroy 协议、可信身份、原始输入与最终权限；校验物理字段；调用原有事务服务及 Repository。
- `access-control/mutation.ts`：允许可信入口提供同步生命周期检查，在事务提交之前复核角色条件依赖的元数据。
- `__tests__/access-control/root-mutation-handler.test.ts`：真实核心 ACL、Repository 及 SQLite/PostgreSQL 的入口用例。

本批明确只处理以主键定位的单条 update/destroy，不改变筛选式批量操作的含义。多条定位、关联写入、外键写入、客户端底层查询选项、输出展开及其他未适配请求全部拒绝。创建、实际路由注册及逐表迁移另行实施。

- [x] 先写普通修改/删除、V 只读、字段过滤、角色条件、历史认领、归属保护、事务回滚和响应用例；确认缺少入口导致失败。
- [x] 复用最终 ACL 捕获契约，仍只读取 `parsedParams` 和独立 `rawParams`，不从已合并 action 参数推导授权。
- [x] 实现受限根入口，复用 `AccessRoleFilterCompiler` 和 `AccessMutationService.withExistingRecords`。角色关系条件是内部授权事实，不要求其可输出；其条件在原写事务中执行。
- [x] 在写事务的异步边界之后复核生命周期，任何失效完整回滚；响应只在事务成功后发布。
- [x] 验证 SQLite/PostgreSQL、原有 mutation/role-filter/final-read-permission 回归、严格类型、lint、格式及租户模块构建；独立审查后按本批功能签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/root-mutation-handler.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。

实际成功断言为 `{ keys: [3], affected: 1 }`，并核对数据库已更新；V-only、无操作权限、错角色或范围及非法参数不得写入且保留原响应。PostgreSQL 使用现有随机独立测试库机制，不能使用业务数据库。

实现核对：核心将更新动作的 `fields` 转为 `whitelist` 后再解析变量，入口沿用这一实际协议。标量角色条件另保留等价 ORM 条件，空布尔组合及 SQL NULL 语义有独立断言；关联条件保留原 SQL 和可串行化事务要求。

独立审查发现记录定位字段可在等待期间变化，导致 Repository 定位与授权主键不一致。新增两个回归先确认失败，再在所有入口生命周期检查中复核该字段，修正后通过；同时验证写入方法未被调用、两条记录及响应均未改变。复审无剩余问题。

读取兼容回归：SQLite/PostgreSQL 共 1458 项通过，覆盖普通读取、关联读取、根请求参数及资源路径解析。严格 TypeScript 检查为 0 项诊断，6 个代码文件的 lint 和格式检查及租户模块构建均通过。

最终写入回归：SQLite/PostgreSQL 共 272 项通过、1 项跳过（该并发元数据用例仅在 PostgreSQL 执行），覆盖新入口及原有 mutation、role-filter、final-read-permission。独立随机 PostgreSQL 测试库已删除；没有接触业务数据。
