# 组合与多层关联筛选计划

沿用已批准的归属性与可见性设计，在当前功能分支实现内部筛选树，不启用业务入口、不改核心或依赖。

- [x] 新增 `access-control/filter-tree.ts` 及 `__tests__/access-control/filter-tree.test.ts`。先用真实数据库测试确认新接口缺失；接口桩因“未实现”失败后才编写实现。
- [x] 筛选树支持 `predicate`、`all`、`any`、`not`、`association`。普通谓词由入口按字段权限解析；每个关联节点明确提供目标及可选中间表稳定身份、各自 ACL 条件，`condition` 在同一条目标记录内继续匹配。来源 ACL 和 G/V 始终放在整棵请求筛选之外。
- [x] 编译前完整校验并快照整棵树、身份、绑定、配置及实际关系元数据，最多 100 个节点、8 层。拒绝未知类型或属性、稀疏数组、循环对象、缺失配置及绑定冲突；即使逻辑分支结果恒真，也不能跳过其他分支的授权校验。
- [x] 复用现有关联解析器和统一查询服务；以只投影连接键的派生查询隔开内外表别名，支持路径绕回已经出现过的表。保留现有单跳关系限制，不新增自关联或跨库支持。每个目标及中间表只编译自己的 G/V 和 ACL，不递归限制规则自身的内部关系事实。
- [x] 覆盖组合条件、同项匹配、嵌套否定、隐藏中间层、绕回路径、多对多重复连接、分页/计数/合计、默认范围/软删除、共享无租户列、事务、异步元数据变化及 20/100 行固定 SQL 次数。
- [x] 单跳 `association-filter.ts` 保留输入契约并改为委托筛选树，避免两份 SQL 实现；新旧能力完成 SQLite/PostgreSQL 回归、严格类型、lint、格式、租户构建及独立复核，作为同一阶段签名原子提交。

内部调用示例（入口必须先完成操作和字段 ACL 检查）：

```ts
await trees.scopeRoots(ctx, documentIdentity, authenticated, {
  sourceWhere: parsedDocumentAcl,
  filter: {
    type: 'association', association: 'project', exists: true, target: projectIdentity,
    targetWhere: parsedProjectAcl,
    condition: {
      type: 'all', children: [
        { type: 'predicate', where: { enabled: true } },
        { type: 'association', association: 'company', exists: true, target: companyIdentity,
          targetWhere: parsedCompanyAcl, condition: { type: 'predicate', where: { name: 'Example' } } },
      ],
    },
  },
});
```

运行：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/filter-tree.test.ts packages/module-tenant/src/server/__tests__/access-control/association-filter.test.ts --reporter=default --maxWorkers=1 --no-file-parallelism`。PostgreSQL 使用随机独立测试库并在结束后清理，禁止使用业务库。计划执行前及每次数据库 await 后调用 `assertCurrent()`。

本阶段不解析客户端 `$and`、点路径等原始过滤，不提供关联排序，不接入实际业务请求。

验证发现并修正了两处问题：Sequelize 忽略包在 SQL Literal 外的 `Op.not`，现使用 ORM 映射后的显式 SQL `NOT`，保留 NULL 语义；共用输入复制函数原先丢失数组尾部空位，现保留原长度，让筛选树正确拒绝稀疏子节点。两项均由失败用例确认后修正。

SQLite 新旧筛选 104 项通过；SQLite/PostgreSQL 合并运行 208 项通过，随机独立 PostgreSQL 测试库已清理。输入复制相关的新增、修改、引用及三类关联展开 SQLite 回归 233 项通过。严格运行时代码类型检查零诊断、oxlint 零警告和错误、Prettier 检查及租户模块构建通过。独立复核确认上述修正有效，未发现其他可操作问题。
