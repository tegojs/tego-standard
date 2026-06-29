# 统一隔离入口收口评估：向 module-data-source 收口

本文档评估将租户强制隔离入口从 `module-tenant` 资源中间件继续向 `module-data-source` 收口的可行性、收益与风险，作为后续实施的决策依据。

## 1. 当前架构概览

### 1.1 隔离入口的两层守卫

当前租户强制隔离由 `module-tenant` 的 `PluginTenantServer.beforeLoad()` 中定义的闭包函数 `applyTenantResourceGuard` 承担，注册为**两层**中间件：

| 层级 | 注册位置 | 作用范围 | 中间件顺序 |
| --- | --- | --- | --- |
| **resourcer 层** | `this.app.resourcer.use(...)` | 主数据源 (main) 的 HTTP 资源请求 | `after: 'acl', before: 'dataSource'` |
| **dataSourceManager 层** | `this.app.dataSourceManager.use(...)` | 非主数据源的 HTTP 资源请求 | `after: 'acl'` |

resourcer 层对 `X-data-source !== 'main'` 的请求直接 `await next()` 跳过，由 dataSourceManager 层接管。dataSourceManager 层需要自行完成认证和租户上下文解析后再执行守卫。

### 1.2 租户上下文解析

`setCurrentTenant` 中间件注册在两个位置：

- `app.resourcer.use(...)` — `after: 'auth', before: 'acl'`（主数据源）
- `app.use(...)` — `after: 'auth', before: 'dataSource'`（全管道，覆盖非 resourcer 请求）

负责从 `X-Tenant-Id` 请求头解析租户、校验用户权限、处理 root 代入、写入 `ctx.state.currentTenant` 等标准字段。

### 1.3 过滤执行

`applyTenantFilter(ctx)` 根据 `ctx.state.currentTenancyMode` 和 action 类型：

- **read** (list/get/count/export/aggregate)：注入 `filter.tenantId`
- **create**：注入 `values.tenantId`
- **update**：注入 `filter.tenantId` + 移除 `values.tenantId`
- **destroy**：注入 `filter.tenantId`
- 支持 `tenantInherited` 模式（`$in: [tenantId, ...descendantIds]`）
- 支持 `legacyDataTenantIds` 读兼容

## 2. 资源访问路径全景

### 2.1 路径分类与覆盖状态

| 路径 | 入口 | 覆盖方式 | 覆盖状态 |
| --- | --- | --- | --- |
| **主数据源标准资源** (resourcer → action → repository) | HTTP 请求 | `tenantResourceGuard` resourcer 层 | ✅ 已覆盖 |
| **非主数据源标准资源** | HTTP 请求 + `X-data-source` header | `tenantResourceGuard` dataSourceManager 层 | ✅ 已覆盖（依赖补偿链） |
| **图表查询** (plugin-block-charts) | HTTP `charts:query` action 内部 compose 管道 | 模块自实现 `applyTenantScope` 中间件 | ✅ 已覆盖（逻辑重复） |
| **导出** (plugin-action-export) | HTTP `exportXlsx:download` + worker 线程 | 主线程从 ctx 提取 tenantContext，worker 内 `applyTenantScopeToWorkerFindOptions` | ✅ 已覆盖 |
| **导入** (plugin-action-import) | HTTP `importXlsx:doImport` | `repository.create({ context: ctx })` 依赖 `tenantId` context field 自动注入 | ✅ 已覆盖（隐式依赖） |
| **文件上传** (module-file) | HTTP `attachments:upload` | collection `tenancy: 'tenantScoped'` + 存储路径 `tenants/{tenantId}/` | ✅ 已覆盖 |
| **Workflow CRUD 指令** (Query/Select/Update/Destroy/UpdateOrCreate/Aggregate) | workflow 引擎内部 repository 调用 | 各 instruction 手动调用 `applyTenantFilterToContext` | ✅ 已覆盖 |
| **Workflow Create 指令** | workflow 引擎内部 `repository.create` | 未调用 `applyTenantFilterToContext`，依赖 `tenantId` context field | ⚠️ 隐式依赖 |
| **Workflow 手动节点表单** (create/update) | workflow 引擎内部 repository 调用 | 无任何租户过滤 | ❌ 未覆盖 |
| **Workflow SQL 指令** | workflow 引擎 `db.sequelize.query(sql)` | 无任何租户过滤 | ❌ 未覆盖（极高风险） |
| **SQL 集合执行** (module-collection) | HTTP `sqlCollection:execute` | 无任何租户过滤 | ❌ 未覆盖（高风险） |
| **View 集合查询** (module-collection) | HTTP `dbViews:query` | 无任何租户过滤 | ❌ 未覆盖（中风险） |
| **Workflow 子工作流触发** | workflow 引擎 `wfRepo.findOne` | 无租户过滤 | ⚠️ 中风险 |
| **Workflow Delay 加载** | 启动时 `model.findAll` | 无租户过滤 | ⚠️ 中风险 |
| **Repository 直连** (module-acl, module-auth 等) | 插件内部 `db.getRepository(...)` | 无守卫 | ✅ 低风险（全部为 shared 系统集合） |

### 2.2 代码重复情况

以下模块**独立实现了**租户过滤逻辑，与 `module-tenant` 的核心实现存在代码重复：

| 模块 | 文件 | 重复内容 |
| --- | --- | --- |
| `plugin-block-charts` | `src/server/actions/query.ts` | `stripTenantFilter`、`applyTenantScope`、`getTenantCacheScope` — 完整复制了过滤逻辑 |
| `plugin-action-export` | `src/server/index.ts` + `src/server/actions/export-xlsx.ts` | `stripTenantFilter`、`applyTenantScopeToWorkerFindOptions` — 完整复制了过滤逻辑 |
| `module-workflow` | `src/server/helpers/tenant-context.ts` | `applyTenantFilterToContext`、`stripTenantFilter`、`buildTenantParams` — 几乎完整复制了 `module-tenant` 的 `tenant-filter.ts` |

三个模块各自维护了一份租户过滤实现，功能高度一致但允许出现漂移。

## 3. 向 module-data-source 收口的可行性分析

### 3.1 module-data-source 当前职责

`PluginDataSourceManagerServer` 管理：

- 数据源生命周期（加载、重载、卸载、状态机）
- Model 注册（`DataSourceModel`、`DataSourcesCollectionModel` 等）
- ACL 集成（角色权限同步到各数据源独立 ACL 实例）
- resourcer 定义（数据源管理 API）
- `DataSourceModel.loadIntoApplication()` 为外部数据源注入 `setCurrentRole` 中间件

**关键事实**：`module-data-source` 当前**不包含任何 tenant/tenancy/isolation 相关代码**。

### 3.2 收口的理论路径

向 `module-data-source` 收口意味着：将租户守卫逻辑从 `module-tenant` 的 HTTP 中间件下推到 `module-data-source` 的数据源管理层面，使得**所有经由数据源的数据访问**（无论主数据源还是外部数据源）都在统一入口处受到租户过滤。

理论上可选的三个层级：

#### 方案 A：在 DataSourceModel.loadIntoApplication 中注入 tenantResourceGuard

```typescript
// DataSourceModel.loadIntoApplication() 中，紧随 setCurrentRole 之后
dataSource.resourceManager.use(tenantResourceGuard, {
  tag: 'tenantResourceGuard',
  after: 'acl',
});
```

**优点**：每个数据源加载时自动携带守卫，不依赖 HTTP 管道的两层补偿。
**缺点**：
- `module-data-source` 会反向依赖 `module-tenant` 的守卫函数。
- 需要处理 `module-tenant` 未启用时的 no-op 边界。
- 仅覆盖外部数据源，主数据源仍需 resourcer 层守卫。

#### 方案 B：在 module-data-source 中定义守卫接口，由 module-tenant 注册实现

```typescript
// module-data-source: 注册 hook 接口
dataSource.on('beforeResourceAction', guardHook);

// module-tenant: 注册实现
app.dataSourceManager.registerGuard('tenantResourceGuard', applyTenantResourceGuard);
```

**优点**：`module-data-source` 不直接依赖 `module-tenant`，通过接口解耦。
**缺点**：
- 需要在 `@tego/server` 核心的 `dataSourceManager` 上新增 `registerGuard` API — 违反「不以前置修改 @tego/server 核心为条件」的约束。
- 增加了一层间接性，调试链路变长。

#### 方案 C：在 module-data-source 的 resourcer 层注册通用守卫管道

```typescript
// module-data-source: 在 beforeLoad 中注册
this.app.resourcer.use(
  async (ctx, next) => {
    // 统一数据源路由：无论主/外部数据源，都在此分发
    const dsKey = resolveDataSourceKey(ctx);
    const ds = dsKey !== 'main' ? ctx.tego.dataSourceManager.dataSources.get(dsKey) : null;
    const db = ds?.collectionManager?.db || ctx.db;
    const collection = resolveCollection(ctx, ds, db);

    // 空管道：等待 tenant 插件注入守卫
    await next();
  },
  { tag: 'dataSourceResolve', before: 'dataSource' },
);
```

**优点**：将数据源路由和集合解析集中到一处，tenant 插件只需在一个位置注入守卫。
**缺点**：
- 仍然不能消除 tenant 插件自身的守卫注册。
- 收益有限，只是换了一个注入点。

### 3.3 核心矛盾

向 `module-data-source` 收口面临一个根本矛盾：

> **租户隔离是业务策略，不是数据源基础设施。**

- `module-data-source` 的职责是管理数据源的**连接、元数据和 ACL**，不应承担业务级的多租户策略。
- `collection.options.tenancy` 的判断依赖 `module-tenant` 的概念模型（`tenantScoped`、`tenantInherited`、`legacyDataTenantIds`、后代租户树）。
- 将这些业务语义下推到 `module-data-source` 会导致**层级倒置**：基础设施层反向依赖业务层。

### 3.4 更务实的收口方向

真正需要收口的不是「守卫放在哪个模块」，而是：

1. **消除重复实现的漂移风险**：图表、导出、workflow 三份独立的 `stripTenantFilter` / `applyTenantFilter` 副本无法通过跨包静态导入统一（会破坏 tenant 可选性），但应通过 **drift test** 保证它们与 `module-tenant` 的权威实现行为一致。
2. **覆盖遗漏路径**：workflow 的 Create、手动节点表单、SQL 指令等路径缺少租户过滤。
3. **Repository 级守卫**：当前守卫仅作用于 HTTP action 管道，不覆盖插件内部直接调用 `repository` 的场景。

## 4. 最小可落地设计

### 4.1 推荐方案：统一工具函数 + Repository 级守卫 + 路径补全

不改变 `module-data-source` 的职责边界，在现有架构上做三件事：

#### 第一步：统一租户过滤工具包（本地 helper + drift test）

消除其他模块中重复副本的目标不变，但**不能通过跨包静态导入实现**。

**约束**：`plugin-block-charts` 和 `plugin-action-export` 的 `package.json` 没有声明 `@tachybase/module-tenant` 为运行时依赖；`module-workflow` 也仅在 `devDependencies` 中。即使从 `@tachybase/module-tenant` 顶层入口（不带 `/server`）导入，当该包未安装时 Node 模块解析同样会失败。因此"从顶层入口导入即可保证 no-op"不成立。

**推荐方案：保留本地 helper + drift test 防漂移**

每个适配插件继续维护自己的精简 helper（当前已有实现），但需补充以下工程约束：

```
plugin-block-charts/src/server/
├── helpers/tenant-filter.ts          // 本地 stripTenantFilter / applyTenantScope（保留）
└── __tests__/
    └── tenant-filter-drift.test.ts   // 新增：对比 module-tenant 权威实现的输出

plugin-action-export/src/server/
├── helpers/tenant-filter.ts          // 本地 stripTenantFilter / applyTenantScopeToWorkerFindOptions（保留）
└── __tests__/
    └── tenant-filter-drift.test.ts   // 新增：drift test

module-workflow/src/server/
├── helpers/tenant-context.ts         // 本地 applyTenantFilterToContext / stripTenantFilter（保留）
└── __tests__/
    └── tenant-context-drift.test.ts  // 新增：drift test
```

**drift test 设计原则**：

1. 测试文件通过 **复制测试用例**（而非运行时导入）引用 `module-tenant` 的权威行为描述 — 在 CI 中，`module-tenant` 始终安装在 workspace 内，测试可以 `import` 它；运行时代码不行。
2. 测试用同一组输入（各种 filter 结构、tenancy 模式）分别喂给本地 helper 和 `module-tenant` 的实现，断言输出一致。
3. 当 `module-tenant` 的过滤行为变更时，drift test 会立即失败，强制适配插件同步更新。
4. 测试文件本身可以安全地 `import from '@tachybase/module-tenant/server'`，因为测试只在 dev/CI 环境运行，workspace 内该包一定存在。

> **关键区分**：测试代码可以依赖 `module-tenant`（devDependency 已满足），运行时代码不可以。

**影响范围**：
- `plugin-block-charts`：保留本地 `stripTenantFilter` / `applyTenantScope`，新增 drift test
- `plugin-action-export`：保留本地 worker 级过滤函数，新增 drift test
- `module-workflow`：保留 `helpers/tenant-context.ts`，新增 drift test

**降级策略不变**：本地 helper 在没有租户上下文（`ctx.state.currentTenant` 不存在）时天然 no-op — 它们只读取 ctx state，不导入任何 tenant 包。

#### 第二步：覆盖 Workflow 遗漏路径

| 文件 | 修复方式 |
| --- | --- |
| `CreateInstruction.ts` | 在 `repository.create` 前调用 `applyTenantFilterToContext(ctx, collection, 'create', options)` |
| `manual/forms/create.ts` | 同上 |
| `manual/forms/update.ts` | 调用 `applyTenantFilterToContext(ctx, collection, 'update', options)` |
| `SQLInstruction.ts` | 不可修复 — 原生 SQL 无法自动注入租户条件。应在 SQL 节点配置 UI 中添加**租户感知警告提示**，并在执行前校验 SQL 中是否引用了 tenantScoped 集合（静态分析或黑名单），或在文档中明确标注 SQL 节点**不保证租户隔离** |
| `TriggerInstruction.ts` | 查找子工作流时追加 `{ filter: { key, enabled: true, tenantId: currentTenantId } }`（如 workflow 本身按租户隔离） |
| `DelayInstruction.ts` | 启动加载 pending 任务时追加 tenantId 过滤（如 delay_jobs 需要按租户隔离） |

#### 第三步：SQL/View 集合的租户边界声明

SQL 集合和 View 集合不支持 `tenancy` 配置（客户端模板已确认），这是**设计决策而非缺陷**：

- SQL 集合 (`sqlCollection:execute`) 和 View 集合 (`dbViews:query`) 本质是原始 SQL 执行，无法在框架层自动注入租户条件。
- **处理方式**：
  1. 在 `sqlCollection:execute` 和 `dbViews:query` 的 ACL 中默认**不授予普通角色**，仅限 root 或管理员。
  2. 在管理界面的 SQL 集合配置中添加醒目的租户隔离警告。
  3. 文档中明确声明：SQL/View 集合不受租户隔离保护，使用者自行确保查询安全。

### 4.2 不推荐的方案

| 方案 | 原因 |
| --- | --- |
| 将 tenantResourceGuard 整体迁移到 module-data-source | 层级倒置，业务策略不应放在基础设施模块 |
| 在 @tego/server 核心中新增 registerGuard API | 违反「不以前置修改 @tego/server 核心为条件」约束 |
| 在 Repository 层全局拦截 | 侵入性太强，影响所有非租户场景的性能和行为 |
| 图表/导出/workflow 直接 `import ... from '@tachybase/module-tenant/server'` | 硬依赖：tenant 包未安装时运行时崩溃 |
| 图表/导出/workflow 直接 `import ... from '@tachybase/module-tenant'` | 同样是硬依赖：charts/export 的 package.json 未声明该依赖，包未安装时 Node 解析失败。顶层入口 no-op 方案不成立 |

### 4.3 外部数据源守卫链的加固

当前外部数据源的租户守卫依赖 `dataSourceManager.use()` 补偿链，该链路需要自行完成认证（`authManager.middleware()`）。这是一个脆弱点。

**建议加固**：由 `module-tenant` 在自身 `beforeLoad` 阶段，遍历已有数据源并注册 `setCurrentTenant` 中间件，同时监听后续数据源加载事件以自动注入：

```typescript
// module-tenant 的 beforeLoad 中（非 module-data-source 内部）
for (const [key, ds] of app.dataSourceManager.dataSources) {
  ds.resourceManager.use(setCurrentTenant, {
    tag: 'setCurrentTenant',
    before: 'acl',
    after: 'auth',
  });
}

// 监听后续加载的外部数据源
app.dataSourceManager.on('afterAddDataSource', (dataSource) => {
  if (app.pm.get('tenant')?.enabled) {
    dataSource.resourceManager.use(setCurrentTenant, {
      tag: 'setCurrentTenant',
      before: 'acl',
      after: 'auth',
    });
  }
});
```

这样外部数据源的 resourceManager 管道自带租户上下文解析，不依赖 `dataSourceManager.use()` 的补偿逻辑，同时**租户业务策略的注册由 `module-tenant` 自身驱动**，不会把 tenant 概念下沉到 `module-data-source`。

## 5. 风险矩阵

| 路径 | 当前风险 | 修复难度 | 修复后风险 |
| --- | --- | --- | --- |
| 主数据源标准资源 | 低 | — | 低 |
| 非主数据源标准资源 | 中（补偿链脆弱） | 低（module-tenant 事件注入） | 低 |
| Workflow CRUD 指令 (Query/Select/Update/Destroy) | 低 | — | 低 |
| Workflow Create 指令 | **高** | 低（加一行调用） | 低 |
| Workflow 手动节点表单 | **高** | 低（加一行调用） | 低 |
| Workflow SQL 指令 | **极高** | 不可修复 | 文档声明 |
| SQL 集合执行 | **高** | 中（ACL 限制） | 中（依赖 ACL 配置） |
| View 集合查询 | **中** | 中（ACL 限制） | 中（依赖 ACL 配置） |
| 图表查询 | 低（逻辑重复） | 低（本地保留 + drift test） | 低 |
| 导出 | 低（逻辑重复） | 低（本地保留 + drift test） | 低 |
| 导入 | 低（隐式依赖） | — | 低 |
| 文件上传 | 低 | — | 低 |
| Repository 直连（系统集合） | 低 | — | 低 |

## 6. 结论

### 6.1 不建议将守卫迁移到 module-data-source

- `module-data-source` 是数据源基础设施层，不应承担业务级租户策略。
- 守卫逻辑（`tenantScoped`/`tenantInherited` 判定、`legacyDataTenantIds` 兼容、后代租户树查询）深度耦合 `module-tenant` 的领域模型。
- 迁移不会减少代码量，反而引入层级倒置和反向依赖。

### 6.2 建议的收口策略

1. **保留本地 helper + drift test**：图表、导出、workflow 各自保留本地租户过滤 helper（运行时不依赖 `@tachybase/module-tenant`），通过 drift test 保证与权威实现行为一致，防止逻辑漂移。
2. **补全遗漏路径**：修复 workflow 的 Create 和手动节点表单。
3. **加固外部数据源守卫链**：由 `module-tenant` 在自身 `beforeLoad` 中通过 `afterAddDataSource` 事件注入 `setCurrentTenant`，而非在 `DataSourceModel.loadIntoApplication` 中注入。
4. **声明 SQL/View 边界**：文档和 ACL 明确 SQL/View 集合不参与租户隔离。
5. **Repository 级守卫暂不引入**：当前所有直连 repository 的生产代码均操作 shared 系统集合，暂无必要全局拦截。后续如有新插件直连 tenantScoped 集合的场景，再评估引入。

### 6.3 预期收益

- 消除 3 处代码重复的漂移风险（本地 helper 保留，drift test 锁定一致性）。
- 修复 3 个高风险绕过路径（Create 指令、手动节点 create/update）。
- 加固外部数据源守卫链，消除认证补偿的脆弱点。
- 明确 SQL/View 集合的安全边界，避免误用。
