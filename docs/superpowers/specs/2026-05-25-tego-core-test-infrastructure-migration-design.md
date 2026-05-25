# Tego 核心测试基础设施迁移设计

## 背景

`tego-standard` 的租户隔离分支已经修复了多条后台链路的租户上下文传播，但为了让这些测试能在当前仓库稳定运行，临时在本仓库维护了较厚的 Vitest 配置和 server test setup。当前本地配置仍依赖 `@tachybase/*` 与 `@tego/*` 核心包，但绕开了默认 `@tachybase/test/vitest` 入口，因为默认入口在 `tego-standard` 的 Node 24、pnpm workspace、外部业务仓库源码插件测试、空 SQLite 测试库场景下无法完整初始化。

这类能力属于核心测试基础设施，不应该长期沉淀在业务仓库里。迁移目标是让 `tego` 核心提供可复用的 server 测试入口，同时让 `tego-standard` 保持薄配置。

## 目标

1. `tego` 核心提供稳定可复用的 Vitest server 测试入口。
2. `tego` 核心修正 `tegod test:server` 的行为，使其明确执行 server 测试或清晰失败，不再误进入 app startup。
3. `tego-standard` 可以复用核心测试能力运行租户隔离相关测试。
4. `tego` 核心原有测试和命令行为保持正常。

## 非目标

1. 不迁移 tenant、workflow、audit 的业务逻辑到 `tego` 核心。
2. 不把 `tego-standard` 的租户测试夹具变成核心默认行为。
3. 不改变生产运行时插件加载逻辑。
4. 不重构整个 devkit/test 包，只迁移当前测试运行所需的通用能力。

## 当前问题

### 默认测试入口不适配外部业务仓库源码插件测试

`tego-standard` 当前需要直接运行 package 源码中的 server tests。默认 `@tachybase/test/vitest` 入口不能完整覆盖这些需求：

- 使用临时 SQLite test DB，避免污染真实环境。
- 在测试环境禁用 runtime plugin DB 加载，避免空测试库缺少 `applicationPlugins` 表。
- 从外部业务仓库的 `packages/*/src/server` 加载插件源码和 collection 定义。
- 在 Node 24 / ESM 环境下处理核心包、devkit、React plugin 和部分 CJS 包的解析。

### `tegod test:server` 行为不清晰

在 `tego-standard` 中执行 `pnpm test:server` 会进入 `tegod test:server`，当前观察到它没有作为明确测试命令运行，而是落入 app startup，进而读取 `.env.test` 指向的空 SQLite DB，并在读取 `applicationPlugins` 时失败。

这会误导开发者：命令名是测试，实际行为却像启动应用。

## 设计方案

### 核心侧：扩展 `@tachybase/test` 的测试能力

在 `tego` 核心仓库中，将通用 server test setup 抽到 `@tachybase/test` 内部或其导出的辅助模块中。该模块负责：

- 初始化 `APP_ENV=test`。
- 配置隔离的临时 SQLite 存储路径。
- 设置测试期 logger 为 error。
- 设置插件源码搜索路径。
- 支持禁用 runtime plugins 和 other plugins 的测试模式。
- 支持按外部 workspace 的包目录解析插件短名。
- 支持按 packageName 从 workspace 源码加载插件入口与 collections。

核心导出应避免绑定 `tego-standard` 的目录结构。外部仓库需要通过参数提供：

```ts
{
  workspaceRoot: process.cwd(),
  pluginPaths: [path.resolve(process.cwd(), 'packages')],
  packageDirByPluginName: {
    'collection-manager': 'module-collection',
    'data-source-manager': 'module-data-source',
    users: 'module-user',
  },
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
}
```

### 核心侧：保持默认 Vitest 配置兼容

`@tachybase/test/vitest` 继续导出默认 Vitest 配置。默认配置应保持 `tego` 核心仓库当前测试可用，同时允许外部仓库通过较薄配置传入 server setup 选项。

理想形态是：

```ts
import { defineTegoVitestConfig } from '@tachybase/test/vitest';

export default defineTegoVitestConfig({
  server: {
    setupOptions: {
      workspaceRoot: process.cwd(),
      pluginPaths: [path.resolve(process.cwd(), 'packages')],
      packageDirByPluginName: {
        'collection-manager': 'module-collection',
        'data-source-manager': 'module-data-source',
        users: 'module-user',
      },
      disableRuntimePlugins: true,
      disableOtherPlugins: true,
    },
  },
});
```

如果为了兼容现有导入方式需要保留默认导出，则默认导出应仍可被 `mergeConfig` 使用。

### 核心侧：修正 `tegod test:server`

`tegod test:server` 应变成明确的测试命令：

- 有 server test 配置时执行 Vitest server project。
- 如果当前项目缺少必要测试配置，应输出清晰错误。
- 不应静默落入 app startup。

这项修改属于 devkit/CLI 测试命令能力，不涉及生产 app startup 行为。

### 业务仓库侧：收窄 `tego-standard` 本地配置

核心能力可用后，`tego-standard` 的 [vitest.config.mts](../../vitest.config.mts) 应删除大部分复制逻辑，改为引用核心导出的配置函数。

[vitest.setup.server.ts](../../vitest.setup.server.ts) 应删除或缩减为项目特定选项。tenant 测试 helper、角色夹具、用户状态夹具仍保留在业务测试目录中，因为它们属于 `tego-standard` 业务测试语义。

## 本地联调策略

优先尝试不发版验证：

1. 在 `tego` 核心仓库完成改动并运行核心测试。
2. 使用本地依赖重定向让 `tego-standard` 读取本地核心包。
3. 若 pnpm link 或 overrides 在跨仓库虚拟 store 下不稳定，则使用 `pnpm pack` 生成本地 tarball，再让 `tego-standard` 指向 tarball 测试。
4. 如果本地重定向仍不可行，则提交核心改动并记录发版验证步骤。

本地验证优先级：

- `tego` 核心测试必须先通过。
- `tego-standard` 关键租户测试必须在重定向到本地核心后通过。

## 验收标准

### `tego` 核心仓库

- `@tachybase/test/vitest` 默认配置仍可用于核心仓库测试。
- 新增的 server test setup 能以参数化方式支持外部 workspace 源码插件测试。
- `tegod test:server` 不再误进入 app startup。
- 核心仓库相关测试通过。

### `tego-standard` 仓库

- [vitest.config.mts](../../vitest.config.mts) 变为薄配置，复用核心导出。
- [vitest.setup.server.ts](../../vitest.setup.server.ts) 删除或仅保留业务侧参数。
- 以下测试通过：
  - `packages/module-tenant/src/server/__tests__/tenant-import.test.ts`
  - `packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts`
  - `packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts`
  - `packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts`

## 风险与约束

- `tego-standard` 当前 workflow date-field schedule 测试存在整文件运行间歇失败，迁移前必须先定位，否则无法可靠判断核心迁移是否引入回归。
- 跨仓库本地依赖重定向可能受 pnpm 虚拟 store 和 package exports 影响；需要保留 tarball 验证方案。
- 核心测试工具必须保持参数化，避免硬编码 `tego-standard` 的包名或目录结构。
- CLI 命令修复必须限制在 test 命令分发路径，不应改变生产启动路径。
