# 多租户隔离第一阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改动 `@tego/server` 核心的前提下，为标准模块仓库落地第一阶段多租户后台闭环，包括租户模型、请求级 `currentTenant`、`tenantScoped` 集合元信息、`tenantId` 自动注入、基础 ACL `tenant` scope 和服务端强制隔离；在不扩大服务端范围的前提下，允许补充最小可用的头像菜单租户切换入口。

**架构：** 新增 `module-tenant` 作为薄租户模块，负责租户模型、租户关系和请求上下文注入；`module-collection` 负责保存集合的 `options.tenancy` 元信息；`module-user` 复用 `context field` 模式为 `tenantScoped` 集合自动补 `tenantId`；`module-acl` 增加 `tenant` scope；当前阶段由 `module-tenant` 的资源中间件统一执行实际 `filter` / `values` 修正，确保读写默认落在当前租户内。后续阶段再将统一隔离入口进一步向 `module-data-source` 收口。

## 当前状态备注

截至当前代码状态，第一阶段主体已完成，并额外落地了一个最小前端入口：

- 已有头像菜单租户切换入口。
- 已有 `tenants:available` 接口供前端获取可切换租户列表。
- 当前仍未提供独立的租户管理后台页面。
- 当前服务端隔离入口仍在 `module-tenant` 资源中间件，不在 `module-data-source`。

因此，后续对第一阶段的复盘应以“代码现状优先”，不要再把“头像菜单切换”视为未实现项。

**技术栈：** TypeScript、Vitest、`@tachybase/test`、`@tego/server`

---

## 文件结构

### 新增

- `docs/superpowers/plans/2026-04-16-tenant-phase-1.md`
- `packages/module-tenant/package.json`
- `packages/module-tenant/server.js`
- `packages/module-tenant/server.d.ts`
- `packages/module-tenant/client.js`
- `packages/module-tenant/client.d.ts`
- `packages/module-tenant/src/index.ts`
- `packages/module-tenant/src/server/index.ts`
- `packages/module-tenant/src/server/server.ts`
- `packages/module-tenant/src/server/collections/tenants.ts`
- `packages/module-tenant/src/server/collections/tenantUsers.ts`
- `packages/module-tenant/src/server/collections/users.ts`
- `packages/module-tenant/src/server/actions/current-tenant.ts`
- `packages/module-tenant/src/server/actions/switch-tenant.ts`
- `packages/module-tenant/src/server/helpers/isTenantScopedCollection.ts`
- `packages/module-tenant/src/server/helpers/tenant-filter.ts`
- `packages/module-tenant/src/server/middlewares/setCurrentTenant.ts`
- `packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts`
- `packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts`
- `packages/module-tenant/src/server/__tests__/utils.ts`

### 修改

- `租户隔离实施规划方案.md`
- `packages/module-collection/src/server/__tests__/collections.repository.test.ts`
- `packages/module-user/src/server/server.ts`
- `packages/module-user/src/server/__tests__/fields.test.ts`
- `packages/module-acl/src/server/server.ts`
- `packages/module-acl/src/server/__tests__/scope.test.ts`
- `packages/module-acl/src/server/__tests__/prepare.ts`
- `tsconfig.paths.json`

## 任务 1：固化文档与计划

**文件：**
- 修改：`租户隔离实施规划方案.md`
- 创建：`docs/superpowers/plans/2026-04-16-tenant-phase-1.md`

- [ ] **步骤 1：补充正式规划文档中的第一阶段技术定稿**

  在正式规划文档中补充以下决策：

  - 集合元信息使用 `collections.options.tenancy`
  - `tenantId` 使用 `context field`
  - `currentTenant` 使用请求级中间件注入
  - 强制隔离由 ACL + 资源中间件双层实现
  - 第一阶段只完成后台闭环

- [ ] **步骤 2：保存第一阶段实现计划**

  将本计划保存到：

  - `docs/superpowers/plans/2026-04-16-tenant-phase-1.md`

## 任务 2：先写失败测试，锁定租户上下文与集合元信息行为

**文件：**
- 创建：`packages/module-tenant/src/server/__tests__/utils.ts`
- 创建：`packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts`
- 修改：`packages/module-collection/src/server/__tests__/collections.repository.test.ts`
- 修改：`packages/module-user/src/server/__tests__/fields.test.ts`
- 修改：`packages/module-acl/src/server/__tests__/scope.test.ts`

- [ ] **步骤 1：为 `collections.options.tenancy` 增加失败测试**

  在 `packages/module-collection/src/server/__tests__/collections.repository.test.ts` 新增测试，验证：

  - 创建集合时传入 `tenancy: 'tenantScoped'`
  - 读取集合记录时该值保存在 `options` 扩展语义中
  - 加载后的 `db.getCollection(name).options.tenancy === 'tenantScoped'`

- [ ] **步骤 2：为 `tenantId` 自动注入增加失败测试**

  在 `packages/module-user/src/server/__tests__/fields.test.ts` 新增测试，验证：

  - 当集合 `options.tenancy === 'tenantScoped'` 时自动补 `tenantId` 字段
  - 创建记录时从 `context.state.currentTenant.id` 自动注入 `tenantId`
  - 手工传入错误 `tenantId` 不应覆盖当前租户值

- [ ] **步骤 3：为 `tenant` scope 增加失败测试**

  在 `packages/module-acl/src/server/__tests__/scope.test.ts` 新增测试，验证：

  - 默认存在 `tenant` scope
  - 其 `scope` 为 `tenantId: '{{ ctx.state.currentTenant.id }}'`

- [ ] **步骤 4：为请求级 `currentTenant` 解析增加失败测试**

  在 `packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts` 新增测试，覆盖：

  - 单租户用户可自动解析默认租户
  - 用户显式传入合法 `X-Tenant` 时可切换到该租户
  - 用户显式传入非法 `X-Tenant` 时返回拒绝

## 任务 3：实现 `module-tenant` 的最小后台骨架

**文件：**
- 创建：`packages/module-tenant/package.json`
- 创建：`packages/module-tenant/server.js`
- 创建：`packages/module-tenant/server.d.ts`
- 创建：`packages/module-tenant/client.js`
- 创建：`packages/module-tenant/client.d.ts`
- 创建：`packages/module-tenant/src/index.ts`
- 创建：`packages/module-tenant/src/server/index.ts`
- 创建：`packages/module-tenant/src/server/server.ts`
- 创建：`packages/module-tenant/src/server/collections/tenants.ts`
- 创建：`packages/module-tenant/src/server/collections/tenantUsers.ts`
- 创建：`packages/module-tenant/src/server/collections/users.ts`
- 创建：`packages/module-tenant/src/server/actions/current-tenant.ts`
- 创建：`packages/module-tenant/src/server/actions/switch-tenant.ts`
- 创建：`packages/module-tenant/src/server/helpers/isTenantScopedCollection.ts`
- 创建：`packages/module-tenant/src/server/helpers/tenant-filter.ts`
- 创建：`packages/module-tenant/src/server/middlewares/setCurrentTenant.ts`
- 修改：`tsconfig.paths.json`

- [ ] **步骤 1：创建模块包骨架**

  创建与现有模块一致的包入口、`package.json`、`server.js`、`server.d.ts`、`client.js`、`client.d.ts`、`src/index.ts` 和 `src/server/index.ts`。

- [ ] **步骤 2：创建租户集合定义**

  新增：

  - `tenants`
  - `tenantUsers`
  - `users` 扩展集合，补 `tenants` / `defaultTenant` 关联

- [ ] **步骤 3：实现请求级租户解析中间件**

  在 `setCurrentTenant.ts` 中实现：

  - 从 `X-Tenant` 读取显式租户
  - 回退到用户默认租户或唯一租户
  - 注入 `ctx.state.currentTenant` 与 `ctx.state.currentTenantId`
  - 对非法租户切换返回错误

- [ ] **步骤 4：实现基础动作**

  新增：

  - `tenants:current`
  - `tenants:switch`

  `switch` 动作先支持用户切换当前租户，不在第一阶段实现完整前端入口。

## 任务 4：实现集合元信息和 `tenantId` 自动注入

**文件：**
- 修改：`packages/module-user/src/server/server.ts`
- 修改：`packages/module-user/src/server/__tests__/fields.test.ts`

- [ ] **步骤 1：在集合定义阶段识别 `options.tenancy`**

  复用 `afterDefineCollection` 钩子，判断：

  - `collection.options.tenancy === 'tenantScoped'`

- [ ] **步骤 2：为 `tenantScoped` 集合补 `tenantId` context field**

  补充：

  - `tenantId` 字段
  - `tenant` 关联字段可先不自动补 UI 关系，第一阶段只确保存储字段存在

- [ ] **步骤 3：保证创建时 `tenantId` 不可被客户端覆盖**

  若已存在 `tenantId` 字段，由后续资源中间件统一覆盖写入值。

## 任务 5：实现 ACL `tenant` scope

**文件：**
- 修改：`packages/module-acl/src/server/server.ts`
- 修改：`packages/module-acl/src/server/__tests__/scope.test.ts`

- [ ] **步骤 1：新增默认 `tenant` scope**

  在 ACL 初始化默认 scope 时增加：

  ```ts
  {
    key: 'tenant',
    name: '{{t("Current tenant records")}}',
    scope: {
      tenantId: '{{ ctx.state.currentTenant.id }}',
    },
  }
  ```

- [ ] **步骤 2：保留现有 `all` / `own` 语义不变**

  第一阶段不重构历史 scope，只追加 `tenant`。

## 任务 6：实现服务端强制租户隔离中间件

**文件：**
- 创建：`packages/module-tenant/src/server/helpers/isTenantScopedCollection.ts`
- 创建：`packages/module-tenant/src/server/helpers/tenant-filter.ts`
- 创建：`packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts`
- 修改：`packages/module-tenant/src/server/server.ts`

- [ ] **步骤 1：实现集合租户语义判断 helper**

  新增 `isTenantScopedCollection(collection)`，识别：

  - `collection.options.tenancy === 'tenantScoped'`

- [ ] **步骤 2：实现统一的租户 filter / values 修正 helper**

  统一处理：

  - `list/get/count`：合并 `tenantId = currentTenant.id`
  - `create`：覆盖 `values.tenantId = currentTenant.id`
  - `update/destroy`：合并过滤条件，确保只命中当前租户

- [ ] **步骤 3：在 `module-tenant` 中注册资源中间件**

  中间件应运行在 ACL 之后、数据执行之前，确保：

  - 只对 `tenantScoped` 集合生效
  - `shared` 集合无影响
  - 普通用户无法通过传参跨租户访问

## 任务 7：接入测试基座并补路径映射

**文件：**
- 修改：`packages/module-acl/src/server/__tests__/prepare.ts`
- 修改：`tsconfig.paths.json`

- [ ] **步骤 1：补 `@tachybase/module-tenant` 路径映射**

  在 `tsconfig.paths.json` 中增加：

  - `@tachybase/module-tenant`
  - `@tachybase/module-tenant/package.json`
  - `@tachybase/module-tenant/client`

- [ ] **步骤 2：在 ACL 测试基座中接入 tenant 模块**

  更新 `prepare.ts` 的插件列表，让 ACL / collection / user 测试可以直接使用 tenant 功能。

## 任务 8：执行验证

**文件：**
- 测试：`packages/module-collection/src/server/__tests__/collections.repository.test.ts`
- 测试：`packages/module-user/src/server/__tests__/fields.test.ts`
- 测试：`packages/module-acl/src/server/__tests__/scope.test.ts`
- 测试：`packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts`
- 测试：`packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts`

- [ ] **步骤 1：运行集合与字段测试**

  运行：`pnpm --filter @tachybase/module-user test -- --run packages/module-user/src/server/__tests__/fields.test.ts`

- [ ] **步骤 2：运行 ACL scope 测试**

  运行：`pnpm --filter @tachybase/module-acl test -- --run packages/module-acl/src/server/__tests__/scope.test.ts`

- [ ] **步骤 3：运行 tenant 模块测试**

  运行：`pnpm test -- --run packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts`

- [ ] **步骤 4：重新运行受影响测试确认全绿**

  运行所有本阶段新增和修改过的测试，确认退出码为 0。

## 下一阶段设计（建议作为 Phase 2 起点）

### 目标

下一阶段不优先做“租户管理后台页面”，而优先把租户上下文和数据读取入口进一步工程化收口，降低后续接入工作流、图表、导入导出时的重复改造成本。

### 推荐范围

- 将标准资源隔离入口从“仅由 `module-tenant` 资源中间件兜底”升级为“`module-data-source` 明确感知 `currentTenant`，`module-tenant` 负责上下文与租户语义”。
- 补齐前端运行时租户上下文消费规范，避免目前仅靠 `window.location.reload()` 刷新页面的弱约定继续扩散。
- 明确租户管理与租户切换的边界：切换继续保留在头像菜单；管理能力单独规划，不混入这一阶段。

### 不建议作为下一阶段主线的内容

- 不优先做独立租户管理后台页面。
- 不优先做历史数据迁移工具。
- 不优先做平台管理员跨租户代入。
- 不优先做工作流、图表、导入导出、附件的全量改造。

### 具体改造方向

1. `packages/module-data-source`

- 为标准资源查询与写入链路显式接入 `ctx.state.currentTenant`。
- 将 `list/get/count/create/update/destroy` 的租户兜底逻辑下沉到更接近数据访问的位置。
- 保持 `module-tenant` 中间件作为保护层，但不再让它长期承担唯一隔离入口。

2. `packages/module-tenant`

- 保留 `setCurrentTenant`、`current/available/switch` 动作和最小前端入口。
- 将“当前租户可用列表”“当前租户对象”抽成更稳定的客户端消费约定。
- 为后续平台管理员代入/切换预留扩展点，但本阶段不实现。

3. `packages/client` / 页面运行时

- 定义统一的当前租户消费方式，而不是让各处自行请求 `tenants:available`。
- 评估是否需要一个全局 tenant store/provider 刷新机制，替代简单整页 reload。
- 保证基础数据请求组件在切换租户后行为一致。

### 建议交付物

- `module-data-source` 租户感知改造方案与测试清单。
- 前端运行时租户上下文刷新方案。
- 第二阶段精确文件级任务表。

### 成功标准

- 租户隔离的主执行入口从“tenant 模块资源中间件”演进为“data-source 主入口 + tenant 模块保护层”。
- 前端切换租户后，不再把整页刷新作为唯一正确性保障。
- 后续工作流、图表、导入导出、附件链路接入时，有稳定统一的租户上下文与数据访问基线可复用。
