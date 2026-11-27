# 请求筛选解析实现计划

> 使用 executing-plans 内联执行；沿用已批准设计，不更改核心、依赖、业务数据或生产配置。

**目标：** 将不可信 JSON 筛选转换为内部筛选树，保持字段操作符的框架语义，并分别检查关联目标和中间表范围。

**架构：** 新增同步 `AccessRequestFilterParser`，由入口提供服务端已确认的读取授权解析函数，返回稳定身份、明确可用字段和已解析 ACL 条件。客户端仅提供条件；不能提供授权、身份、SQL 或绑定。字段谓词使用核心 `FilterParser`，关联使用 `AccessFilterTreeService`，不生成关联 JOIN。

**文件：** 新建 `access-control/request-filter.ts` 和 `__tests__/access-control/request-filter.test.ts`；更新既有设计中的实际进度。

- [x] 添加接口桩和真实数据库用例：`{ 'projects.company.name': { $includes: 'Owned' } }` 只返回根记录 1；先运行确认桩因未实现失败。
- [x] 实现 JSON 校验及快照：只接受有限 JSON 值、标准密集数组和普通对象，拒绝对象与数组访问器、原型对象、符号、函数、循环、超长键和值、超大数组及超深输入。点路径另设长度与关联深度限制。快照在授权解析前完成。
- [x] 支持普通字段值、有限列表、等于/不等于、大小比较、包含/前后缀、空值、布尔操作符；复用框架解析且不产生 include。JSON/数组字段、日期快捷操作符及自定义操作符暂不开放，不支持时明确拒绝；框架 `$ne`、`$notIn` 语义沿用核心解析器。
- [x] 支持 `$and`、`$or`、`$not`、嵌套和点路径关联。来源和每一跳关联字段都检查服务端读取授权；目标、中间表分别授权。同一对象内共享关联路径递归合并，确保深层条件匹配同一项。逻辑、存在性条件之间或它们与普通条件之间出现重叠关联路径时明确拒绝，防止不同关联记录分别满足条件。
- [x] `$exists` / `$notExists` 支持关联路径、深层目标 `id` 主键形式及关联普通字段形式。关联形式只接受显式 `true` 标记，反向表示不存在可读匹配；不能用隐藏目标的存在性做推断。普通字段沿用核心标量操作符语义。
- [x] SQLite 与随机独立 PostgreSQL 测试覆盖根/目标/中间表范围、G/V、隐藏项、同项匹配、重复连接、计数/金额、共享路径、注入文本绑定、输入边界、ACL 拒绝及 SQL 次数。未知操作符、未授权字段和无效输入明确拒绝，不静默丢条件。
- [x] 最终双库聚焦回归、严格类型、oxlint、Prettier、租户构建和独立代码审查通过，按本阶段范围签名原子提交。

接口示例：

```ts
const parser = new AccessRequestFilterParser(db, (collection, path) => {
  // 入口按既有角色关联 ACL 协议预先解析权限；这是服务端函数，不能接受客户端授权。
  return authorizedReadScopes.get(path.join('.')) ?? null;
});
const request = parser.parse(documentIdentity, {
  projects: { enabled: true, company: { name: { $includes: 'Example' } } },
});
const plan = await trees.scopeRoots(ctx, documentIdentity, authenticated, request);
plan.assertCurrent();
const rows = await documents.model.findAll(plan.query);
plan.assertCurrent();
```

运行：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/request-filter.test.ts packages/module-tenant/src/server/__tests__/access-control/filter-tree.test.ts packages/module-tenant/src/server/__tests__/access-control/association-filter.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。禁止使用业务库。真实业务入口启用前还需补齐日期、扩展操作符、关联排序及未迁移表适配，不能把本阶段声明为全部请求语法兼容。

当前实现仅提供内部 `AccessRequestFilterParser`，没有连接资源 API、ACL grant 解析或业务页面。入口接入前必须传入服务端计算的授权字段与范围；测试使用的默认授权 resolver 不得用于真实入口。

验证记录（2026-10-14）：请求解析、组合筛选树和单跳筛选共 238 项 SQLite/PostgreSQL 测试通过。PostgreSQL 使用随机命名的本地专用库，退出后已删除并确认清理。源码与测试的严格 TypeScript 检查（含未使用变量检查）为 0 诊断；oxlint、Prettier 和 `pnpm exec tegod build @tachybase/module-tenant` 通过。独立审查发现的深层同项匹配、混合逻辑重叠、来源关联字段授权和数组访问器问题均已补充失败用例并修复，最终复核无新增具体缺陷。没有操作业务库或生产配置。
