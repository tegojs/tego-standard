# 租户树状结构设计

> 状态：已批准 | 日期：2026-05-09

## 背景

当前租户模块采用扁平结构（所有租户平级），不支持组织层级关系。需要改造成树状结构，支持总公司 → 分公司 → 子部门等多层嵌套。

## 需求决策

| 决策项 | 结论 |
|---|---|
| 数据可见性 | 自上而下 — 父租户可见所有子孙租户的数据 |
| 层级深度 | 不限 |
| 用户归属 | 任意节点，可多归属（保持现有 tenantUsers 多对多） |
| 管理权限 | 父租户管理员可管理子租户 |

## 数据模型

### tenants 集合变更

新增字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `parentId` | `string (uid)` | 父租户 ID，null = 根节点 |
| `parent` | `belongsTo` | 指向 `tenants`，foreignKey: `parentId` |
| `children` | `hasMany` | 指向 `tenants`，foreignKey: `parentId` |
| `path` | `string` | 物化路径，格式 `/<id1>/<id2>/<id3>/` |

path 示例：
```
tenant-a (总公司)     path = "/tenant-a/"
tenant-b (分公司1)    path = "/tenant-a/tenant-b/"
tenant-c (分公司2)    path = "/tenant-a/tenant-c/"
tenant-d (子部门)     path = "/tenant-a/tenant-b/tenant-d/"
```

### collections.options.tenancy 扩展

| 值 | 含义 | 过滤 SQL |
|---|---|---|
| `'tenantScoped'` | 严格单租户隔离（现有） | `tenantId = ?` |
| `'tenantInherited'` | 继承子孙可见（新增） | `tenantId IN (?)` |

不设置 tenancy 的集合不受租户过滤影响（现有行为不变）。

## 核心逻辑

### 1. 子孙查询（物化路径）

```sql
SELECT id FROM tenants WHERE path LIKE '/<currentTenantId>/%'
```

配合 `parentId` 索引和 `path` 索引，性能可控。

### 2. 创建租户

```
1. 接收 parentId 参数（可选，null = 根节点）
2. 创建 tenant 记录
3. path = parent ? parent.path + newId + '/' : '/' + newId + '/'
4. 如果有 parentId，验证父租户存在且 enabled
```

### 3. 移动租户（改变父节点）

```
1. 计算 oldPrefix = current.path
2. 更新 parentId
3. 计算 newPrefix = newParent.path + currentId + '/'
4. UPDATE tenants SET path = REPLACE(path, oldPrefix, newPrefix)
   WHERE path LIKE '<oldPrefix>%'
```

### 4. setCurrentTenant 中间件变更

在现有逻辑基础上，解析完 currentTenant 后，额外查询子孙 ID 列表：

```
ctx.state.currentTenantDescendantIds = await getDescendantIds(currentTenantId)
```

### 5. applyTenantFilter 变更

根据集合的 tenancy 模式选择过滤方式：

```typescript
if (tenancy === 'tenantScoped') {
  // 现有行为：严格等于
  filter.tenantId = currentTenantId
} else if (tenancy === 'tenantInherited') {
  // 新行为：包含子孙
  filter.tenantId = { $in: [currentTenantId, ...descendantIds] }
}
```

### 6. 管理权限判断

父租户管理子租户的权限判断：

```typescript
function canManageTenant(managerTenantId: string, targetTenant: Tenant): boolean {
  return targetTenant.path.startsWith(`/${managerTenantId}/`)
}
```

### 7. tenantUsers 变更

无结构性变更。用户仍通过 tenantUsers 多对多归属到任意租户节点。

available-tenants action 需要扩展：除了用户直接归属的租户，也应包含这些租户的所有祖先（让用户能向上切换到父租户）。

## 不变的部分

- tenantUsers 中间表结构不变
- 用户的 defaultTenantId 机制不变
- 客户端 localStorage 存储 current_tenant_id 的方式不变
- 非 tenantScoped / tenantInherited 的集合不受影响

## 边界情况

| 场景 | 处理方式 |
|---|---|
| 删除有子节点的租户 | 拒绝删除，先删除或移动子节点 |
| 禁用父租户 | 不自动级联禁用子孙，但子孙的 path 仍包含被禁用父节点 |
| 循环引用 | 通过 path 前缀检查防止（新 parent 的 path 不能是当前节点 path 的前缀） |
| path 过长 | 设置 maxLength（如 500），超过时拒绝创建更深层级 |
| 用户归属父租户，切换到子租户 | 通过 available-tenants 提供可切换列表，switch 动作验证 path 关系 |

## 测试策略

- 现有所有测试必须继续通过（向后兼容）
- 新增：树结构创建/移动/删除
- 新增：tenantInherited 模式下的数据过滤
- 新增：父租户管理子租户的权限验证
- 新增：边界情况（循环、深度限制、删除有子节点的租户）
