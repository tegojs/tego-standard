# 关联存在性筛选计划

沿用已批准设计，在当前功能分支实现内部单跳筛选计划，不接入业务、不改依赖或核心。

- [x] 新增 `packages/module-tenant/src/server/__tests__/access-control/association-filter.test.ts`。真实 SQLite/PostgreSQL 验证四类关联的正向/反向存在性、三个独立读取边界及根记录计数/合计不重复。先运行确认能力缺失而失败。
- [x] 新增 `packages/module-tenant/src/server/access-control/association-filter.ts` 的 `AccessAssociationFilterService.scopeRoots`。输入来源、目标及可选中间表稳定身份，关联名、布尔 `exists`，各表独立服务端解析的 ACL/请求条件及命名绑定。复用注册关系解析器、统一查询服务及元数据守卫，生成相关 `EXISTS`/`NOT EXISTS`，不加载关联 ID、不查询每行。
- [x] 返回来源的 `ScopedAccessQuery` 和 `assertCurrent()`；调用方执行列表/计数/合计之前及之后检查守卫，不得在配置释放或模型变化后复用计划。入口仍负责操作权限、字段权限和谓词解析。拒绝跨库、自关联别名冲突、缺失配置、不符合关联的中间身份及额外选项。
- [x] 验证隐藏目标/连接不参与正向或反向判断；NULL 外键与无关联符合“不存在”。保留默认范围、关联 scope、软删除、参数隔离和事务。共享表不强加租户字段；授权规则本身的关系仍为内部授权事实，不递归加目标权限。
- [x] 运行新文件及相邻读取、统一查询和元数据回归，严格类型、lint、格式和租户模块构建；独立复核无待修问题，按本阶段签名原子提交。

运行：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/association-filter.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 使用随机独立测试库并清理，禁止触及业务库。

本阶段仅提供一个明确关联的存在性原语。多层关联、多个筛选的逻辑组合与普通请求过滤解析、关联排序、业务入口接入另行完成；不能将本阶段视为全部关联筛选已支持。

验证结果：先确认接口桩因“未实现”失败，再实现能力。最终新文件 SQLite/PostgreSQL 共 108 项通过，随机独立 PostgreSQL 库已删除；随后 SQLite 新文件及相邻读取、统一查询、元数据共 5 文件 150 项通过。两组包含重复用例，不相加。独立复核另跑 SQLite 54 项通过。严格运行时 TypeScript 为 0 诊断，lint 为 0 错误/警告，租户模块构建、格式及 diff 检查通过。未修改业务数据库、核心或依赖。
