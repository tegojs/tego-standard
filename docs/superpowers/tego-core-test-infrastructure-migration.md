# Tego 核心测试基础设施迁移计划

本文档合并原 `docs/superpowers/plans/2026-05-25-tego-core-test-infrastructure-migration-plan.md` 与 `docs/superpowers/specs/2026-05-25-tego-core-test-infrastructure-migration-design.md`。原文包含大量逐行实现草稿，已压缩为当前需要保留的目标、边界和任务清单。

## 背景

租户隔离分支为了稳定运行 server tests，在 `tego-standard` 内维护了较厚的 `vitest.config.mts` 与 `vitest.setup.server.ts`。这些能力本质上是通用测试基础设施，应迁回 `tego` 核心，避免业务仓库长期复制核心测试初始化逻辑。

当前主要问题：

- 默认 `@tachybase/test/vitest` 入口不完全适配外部业务仓库源码插件测试。
- server tests 需要临时 SQLite、禁用 runtime plugins、从 workspace `packages/*/src/server` 加载插件源码和 collections。
- `tegod test:server` 曾出现落入 app startup 的风险，容易读取空 `.env.test` 数据库并触发 `applicationPlugins` 缺表错误。
- `tego-standard` 本地测试配置重复了本应由核心提供的 PluginManager patch、测试数据库初始化和 Vitest projects 定义。

## 目标

- `tego` 核心提供可复用的 server test environment setup。
- `@tachybase/test/vitest` 导出配置工厂，外部仓库可以用薄配置复用核心 Vitest projects。
- `tegod test`、`tegod test:server`、`tegod test:client` 明确执行 Vitest，不再误进入应用启动。
- `tego-standard` 收窄为项目特定 setup 参数和少量必要 alias。

## 非目标

- 不迁移 tenant、workflow、audit 等业务逻辑到核心仓库。
- 不把 `tego-standard` 的租户测试夹具变成核心默认行为。
- 不改变生产运行时插件加载逻辑。
- 不重构整个 devkit/test 包，只迁移当前测试运行所需的通用能力。

## 推荐任务拆分

### 任务 1：稳定业务仓库现有关键测试

先恢复或稳定 workflow date-field schedule 租户测试，避免核心迁移时混入既有间歇失败。

验证命令：

```bash
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts --config vitest.config.mts
```

### 任务 2：在 `tego` 核心抽出 server test environment setup

核心包提供参数化入口，例如：

```ts
setupServerTestEnvironment({
  workspaceRoot: process.cwd(),
  pluginPaths: [path.resolve(process.cwd(), 'packages')],
  packageDirByPluginName: {
    'collection-manager': 'module-collection',
    'data-source-manager': 'module-data-source',
    users: 'module-user',
  },
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
});
```

该入口负责：

- 设置 `APP_ENV=test`
- 创建隔离的临时 SQLite 数据库
- 设置测试期 logger 为 error
- 设置插件源码搜索路径
- 禁用 runtime plugins 和 other plugins
- 支持外部 workspace 插件短名到包目录的映射
- 支持从 workspace 源码加载 server plugin 与 collections

### 任务 3：导出核心 Vitest 配置工厂

`@tachybase/test/vitest` 保留默认导出，并新增配置工厂：

```ts
import { defineTegoVitestConfig } from '@tachybase/test/vitest';

export default defineTegoVitestConfig({
  server: {
    setupFile: path.resolve(process.cwd(), './vitest.setup.server.ts'),
  },
});
```

如果需要额外 alias，应只保留外部业务仓库确实需要的项目差异。

### 任务 4：修正 devkit 测试命令

在 `@tego/devkit` 注册明确的测试命令：

- `tegod test`
- `tegod test:server`
- `tegod test:client`

验收要求：命令输出 Vitest `RUN`，不进入 app startup。

### 任务 5：让 `tego-standard` 使用薄配置

`vitest.setup.server.ts` 只保留业务仓库参数：

```ts
setupServerTestEnvironment({
  workspaceRoot: process.cwd(),
  pluginPaths: [path.resolve(process.cwd(), 'packages')],
  packageDirByPluginName: {
    'collection-manager': 'module-collection',
    'data-source-manager': 'module-data-source',
    users: 'module-user',
  },
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
});
```

`vitest.config.mts` 使用核心配置工厂，不再复制完整 projects。

## 本地联调策略

优先使用本地 link；如果 pnpm 虚拟 store 或 package exports 导致解析不稳定，则使用 tarball 验证。

核心仓库验证：

```bash
pnpm exec vitest run packages/test/src/__tests__/server-test-environment.test.ts packages/test/src/__tests__/vitest-config.test.ts packages/devkit/src/__tests__/test-command.test.ts --config vitest.config.ts
pnpm tegod test:server -- --run packages/test/src/__tests__/vitest-config.test.ts
```

业务仓库验证：

```bash
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
pnpm test:server -- --run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts
```

## 验收标准

- 核心仓库默认测试配置保持兼容。
- 外部仓库可以通过参数化 setup 运行源码插件 server tests。
- `tegod test:server` 不再落入应用启动路径。
- `tego-standard` 的 Vitest 配置显著变薄。
- 租户隔离关键测试在迁移后仍通过。
