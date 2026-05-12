# 租户树状结构 — 实现计划

> 设计文档：`docs/superpowers/specs/2026-05-09-tenant-tree-structure-design.md`

## 变更清单

### Phase 1：数据模型（tenants 集合）

**文件：`packages/module-tenant/src/server/collections/tenants.ts`**
- 添加 `parentId` 字段（string uid，nullable）
- 添加 `parent` 关系（belongsTo self）
- 添加 `children` 关系（hasMany self）
- 添加 `path` 字段（string，maxLength 500）

### Phase 2：服务端核心逻辑

**文件：`packages/module-tenant/src/server/helpers/tenant-filter.ts`**
- `applyTenantFilter` 支持 `tenantInherited` 模式
- 当 tenancy === 'tenantInherited' 时，使用 `$in` 过滤而非 `=`

**文件：`packages/module-tenant/src/server/helpers/isTenantScopedCollection.ts`**
- 导出辅助函数 `isTenantInheritedCollection(collection)`
- 或改为返回 `tenancy` 值而非布尔

**文件：`packages/module-tenant/src/server/middlewares/setCurrentTenant.ts`**
- 解析 currentTenant 后，查询子孙 ID 列表
- 写入 `ctx.state.currentTenantDescendantIds`

**文件：`packages/module-tenant/src/server/helpers/tenant-tree.ts`（新建）**
- `getDescendantIds(repo, tenantId)` — 查询子孙 ID
- `getDescendantTenants(repo, tenantId)` — 查询子孙完整记录
- `buildPath(parentPath, id)` — 拼接路径
- `canManageTenant(managerTenantId, targetTenant)` — 权限判断
- `wouldCreateCycle(repo, tenantId, newParentId)` — 循环检测

**文件：`packages/module-tenant/src/server/server.ts`**
- tenantResourceGuard 中间件支持 tenantInherited

**文件：`packages/module-tenant/src/server/actions/`（修改现有 + 新增）**
- `switch-tenant.ts` — 验证切换目标时考虑 path 关系
- `available-tenants.ts` — 扩展：包含用户归属租户的所有祖先
- 新增 `create-tenant.ts`（如有必要，或内联到 server.ts 的 collection hook）
- 新增 `move-tenant.ts`（或在 update 中处理 parentId 变更）

**文件：`packages/module-tenant/src/server/collections/tenants.ts` + server.ts hooks**
- beforeCreate hook：自动生成 path
- beforeUpdate hook：parentId 变更时重建子树 path
- beforeDestroy hook：有子节点时拒绝删除

### Phase 3：国际化

**文件：`packages/module-tenant/src/server/locale/en-US.ts` 和 `zh-CN.ts`**
- 添加树相关的新错误消息和标签

### Phase 4：测试

**文件：`packages/module-tenant/src/server/__tests__/tenant-tree.test.ts`（新建）**
- 创建子租户自动设置 path
- 子孙查询正确性
- 移动租户后 path 更新
- 循环引用拒绝
- 删除有子节点的租户被拒绝
- 深度限制

**文件：现有测试更新**
- `set-current-tenant.test.ts` — 添加树结构下的解析测试
- `tenant-filter.test.ts` — 添加 tenantInherited 模式测试
- `tenant-resource-guard.test.ts` — 添加继承模式下的 CRUD 隔离测试
- `tenant-export.test.ts` / `tenant-import.test.ts` — 确保继承模式下导入导出正确

### Phase 5：客户端（后续独立 PR 可选）

- `TenantManagement.tsx` — 将列表改为树形展示
- `useSwitchTenant.tsx` — 租户切换支持树形结构
- 此阶段暂不改客户端，仅做服务端改造

## 执行顺序

1. Phase 1 → Phase 2 → Phase 3 → Phase 4
2. 每个 Phase 完成后运行测试确认无回归
3. Phase 5 视需要后续进行
