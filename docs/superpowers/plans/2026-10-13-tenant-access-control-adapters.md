# 租户访问规则真实模型适配

**目标：** 将服务端真实 Collection、Sequelize 关系和可信身份转换成第一阶段规则输入，保持软删除、固定筛选及事务边界。本阶段不启用业务表新模式。

**执行：** 在 `feat/tenant-access-control` 顺序完成，使用先测试后实现的方式。不修改依赖、核心仓库、线上配置和业务数据库。

## 1. 真实模型与查询约束

- [x] 新增 `access-control/model-metadata.ts` 和 `__tests__/access-control/model-metadata.test.ts`。
- [x] 使用内存数据库的真实 Collection 验证字段列名、belongsTo、hasOne、hasMany、多对多和自定义关联键，执行编译后的 SQL 核对实际结果。
- [x] 为元数据增加服务端固定条件，在根表、关联目标及中间表查询中保留软删除和固定筛选。
- [x] 对复杂默认 scope、SQL 表达式、不支持字段及跨数据库关系明确拒绝；未被规则使用的关系不影响其他规则。
- [x] 稳定标识由服务端解析函数提供，不以表名冒充持久化标识；关系元数据按需展开，不遍历整个业务关系图。

## 2. 可信上下文和事务内层级

- [x] 新增 `access-control/context.ts` 和 `__tests__/access-control/context.test.ts`。
- [x] 仅接收服务端已经认证的身份；按启用规则需要的变量解析，忽略请求头及缓存层级列表。
- [x] 当前租户存在且启用；需要层级时从同一数据库事务读取 parentId，验证循环和数据量上限，不依据名称或不可靠路径猜测。
- [x] 验证停用、缺失租户、无关租户、空层级、父子方向、层级更新及事务内未提交变更。
- [x] 共享规则无需租户变量时不读取租户数据；身份缺失不能取反放行。

## 3. 联合验证及边界说明

运行：

```powershell
pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control packages/module-tenant/src/server/__tests__/tenant-filter.test.ts packages/module-tenant/src/server/__tests__/legacy-data-claim.test.ts --reporter=default
pnpm exec oxlint packages/module-tenant/src/server/access-control packages/module-tenant/src/server/__tests__/access-control
pnpm exec tegod build @tachybase/module-tenant
```

- [x] 聚焦测试、格式检查、代码检查和租户模块构建通过。
- [x] 记录真实通过数量，以及 PostgreSQL 原型是否实际执行；未提供专用测试连接时不能把跳过说成通过。
- [x] 复核运行入口未启用新模型，现有租户过滤与历史认领未改变。

## 实际验证结果

7 个测试文件、149 项测试通过，无跳过。分别为规则编译 46 项、SQLite 查询 29 项、真实模型适配 24 项、可信上下文 16 项、PostgreSQL 原型 11 项、现有过滤及历史认领回归 23 项。PostgreSQL 在独立本地测试库实际执行，包含真实模型固定条件以及事务内层级解析；测试库在验证后删除，未使用业务数据库进行写入。

租户模块构建、6 个实现文件的严格 TypeScript 检查，以及 13 个 TypeScript 文件的 oxlint 和 Prettier 检查通过。新增逻辑尚未被插件运行入口导入。

审查补测修正了真实日期字段的绑定格式、对象形式 OR 与空分组的 Sequelize 语义。固定条件的支持范围为标量比较、集合、NULL、AND/OR/NOT；任意 SQL、复杂表达式、改变查询集合的其他 scope 选项及无法正确转换的空 IN 列表明确拒绝。软删除限制适用于根模型、关联目标和中间模型；多对多关联主动覆盖中间表软删除行为暂不支持。

真实模型适配目前仅允许已验证的 PostgreSQL 和 SQLite。整数普通字段保留数值比较能力，日期绑定使用模型自身格式化函数。身份函数接收已认证的服务端身份，并不替代登录、租户成员或角色认证。需要层级时读取 parentId 图，最多加载 10000 个租户、有效上下文列表最多 1000 项，超限拒绝而非截断。停用节点不获得授权，但可经过停用中间节点继续确认启用祖先或后代，沿用现有层级语义。

本阶段只证明适配与查询能力。写事务隔离级别、角色 ACL、权威规则版本、跨数据源事务以及所有业务入口的保护仍由后续统一服务负责，不能据此启用业务表新模式。

接下来才实现权威配置加载、角色范围来源识别、完整查询及写入入口接入。当前适配器读取授权关系仅用于规则判断，不扩大响应中的关联数据。
