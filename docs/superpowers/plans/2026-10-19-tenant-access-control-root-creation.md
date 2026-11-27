# 普通记录新增的最终权限接入

沿用已确认设计和现有功能分支，使用 executing-plans 与 test-driven-development 实施。目标是在现有 `AccessRootMutationHandler` 增加单条根 `create`，复用真实核心最终操作权限、字段白名单、黑名单和角色条件，再由原有 `AccessCreationService` 检查持久化后的归属性 G。V 仍不能新增。

文件职责：`access-control/root-mutation-handler.ts` 接收无定位参数的单对象新增并使用 Repository；`access-control/creation.ts` 增加可信同步生命周期检查，在事务返回前检查入口与角色依赖；`__tests__/access-control/root-creation-handler.test.ts` 用真实 ACL/Resourcer/Repository 覆盖入口；设计文档更新本批范围。

- [x] 先写失败测试：生成主键、模型默认值、字段权限、角色条件、G/V 区分、归属注入与伪造拒绝、缺少租户、共享配置、错误输入和钩子回滚。
- [x] 运行聚焦新增测试，确认当前处理器拒绝 create，而非测试环境错误。
- [x] 最小化扩展原处理器，不重复建立权限解析。新增只接受一个普通对象，不接收定位、用户筛选、关联、外键和底层查询选项。默认值仍由模型提供；客户端字段权限仅过滤输入，最终默认值和钩子结果也必须满足 G 与角色范围。
- [x] 新增事务检查复用原 INSERT 来源核验、归属保护和冲突处理。补上入口生命周期检查；元数据或准备阶段在任何异步边界后失效时，事务回滚且原响应不变。
- [x] 验证 SQLite/PostgreSQL 新增和已有写入回归、严格类型、lint、格式和租户模块构建。独立审查后按本批功能签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/root-creation-handler.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。成功返回 `{ keys: [生成的主键], affected: 1 }`，并核对数据库实际值；失败断言记录数不变。PostgreSQL 只使用已有随机独立测试库机制。

本批不注册资源路由、不启用业务表、不更新依赖。批量新增、嵌套关联和输出展开不在本批范围内。

首轮 34 项中 14 项因缺少 create 入口失败，扩展后全部通过。随后加入最终授权查询后元数据变化的回归：没有入口生命周期检查时请求错误地成功，补上检查后正确回滚。新增入口的 SQLite 用例最终 40 项通过、2 项 PostgreSQL 专属用例跳过。

最终验证：SQLite/PostgreSQL 的新入口及既有 root-mutation-handler、creation、mutation、role-filter 共 413 项通过，3 项跳过（这些用例仅在 PostgreSQL 执行）。严格 TypeScript 检查为 0 项诊断；修改代码的 lint、格式检查和租户模块构建通过。独立审查无待修问题。随机 PostgreSQL 测试库已删除，未更改业务数据。
