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

## 2026-06-12 实现复核备注

本节记录当前代码实现与原设计之间的差异，避免后续维护时按旧描述误判状态。

- `tenantInherited` 的读过滤、`currentTenantDescendantIds` 上下文、租户树 path 创建/移动/删除非叶子保护已落地。
- `available-tenants` 当前实现返回用户直接归属租户及其 enabled 子孙租户，不返回祖先租户；当前测试也按“父可切子、子不可切父”的规则断言。这与下文“包含用户直接归属租户的所有祖先”的原设计不同，需要产品确认后再决定是改代码还是更新设计决策。
- `path` 字段已设置 `maxLength: 500`，并已在 `buildPath` 中补充 hook 级长度校验；创建或移动导致 path 超过 500 字符时会提前抛出明确错误。
- 后台链路仍需按实施规划继续补齐：workflow 直连 repository 强制过滤、date-field schedule 的后代范围、legacy 旧数据读范围、异步导出完整上下文和图表缓存最终作用域。
- 历史数据迁移、灰度开关和回滚工具尚未实现；当前旧数据兼容主要通过读时 `legacyDataTenantIds` 暂时解决“未迁移旧数据可见性”问题。

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

## 后台链路租户上下文传播

租户树和 `tenantInherited` 过滤只覆盖请求内资源访问。导入、工作流、审计这类后台链路需要显式携带或恢复租户上下文，避免在脱离 HTTP 请求后绕过租户过滤。

### 导入 transform

导入主记录创建必须继续由服务端注入当前 `tenantId`。导入过程中的关联字段解析也必须传递当前请求 `context`：

- `tenantScoped` 目标集合只匹配当前租户记录。
- `tenantInherited` 目标集合匹配当前租户及其子孙租户记录。
- 共享目标集合保持共享查询语义，不额外添加租户过滤。

### Workflow execution

workflow execution 创建时保存触发时的租户上下文，不保存完整 Koa `ctx`：

- `tenantId`
- `currentTenant`
- `currentTenantId`
- `currentTenantDescendantIds`

异步执行、resume、retry 和补偿任务从 execution 恢复上述上下文，并把它作为 repository 操作的 `context`。定时任务如果处理 tenant-enabled 集合，应按租户上下文分片执行，而不是无上下文全量扫描。

### 审计与平台管理员代入

审计日志记录 effective tenant 与 actor user。平台管理员代入租户时只改变 effective tenant，不覆盖 `currentUser`：

- `tenantId`：本次操作作用的租户。
- `actorUserId`：真实操作者。
- `impersonatedTenantId`：平台管理员代入的目标租户。
- `tenantContextSource`：普通成员上下文或平台代入上下文。
- `isTenantImpersonation`：是否为平台管理员代入。

普通用户仍必须通过 tenantUsers 和租户树访问关系校验，不能通过请求头伪造其他租户上下文。

## 测试策略

- 现有所有测试必须继续通过（向后兼容）
- 新增：树结构创建/移动/删除
- 新增：tenantInherited 模式下的数据过滤
- 新增：父租户管理子租户的权限验证
- 新增：边界情况（循环、深度限制、删除有子节点的租户）
- 新增：导入关联查询在 A/B 租户同名记录下只匹配当前租户可见记录
- 新增：workflow 异步执行、resume、retry 后仍使用触发时租户上下文
- 新增：日期字段定时 workflow 不跨租户扫描 tenant-enabled 集合
- 新增：审计日志记录租户、真实操作者和平台管理员代入信息
