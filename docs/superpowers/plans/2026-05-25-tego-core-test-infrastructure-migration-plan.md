# Tego 核心测试基础设施迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `tego-standard` 当前复制出来的通用 server Vitest 初始化能力迁移到 `tego` 核心，并修正 `tegod test:server` 的测试命令行为。

**架构：** 先稳定 `tego-standard` 当前关键测试，避免迁移时混入既有不稳定因素；再在 `tego/packages/test` 提供参数化 server test setup 和 Vitest 配置工厂；随后在 `tego/packages/devkit` 注册明确的 `test` / `test:server` / `test:client` 命令；最后让 `tego-standard` 通过薄配置复用核心能力，并用本地 link 或 tarball 验证。

**技术栈：** TypeScript、Vitest 3、pnpm workspace、Commander、Tego core PluginManager、`@tachybase/test`、`@tego/devkit`、SQLite test database。

---

## 文件结构

### `tego-standard` 仓库

- 修改：`packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts`
  - 职责：稳定当前 workflow date-field schedule 租户上下文测试，避免整文件运行时因为硬编码 sleep 时间窗口造成间歇失败。
- 修改：`vitest.config.mts`
  - 职责：从厚配置改为复用 `@tachybase/test/vitest` 的配置工厂，只保留 `tego-standard` 特有的 alias 和 workspace plugin 映射。
- 删除或缩减：`vitest.setup.server.ts`
  - 职责：迁移后不再保存通用 PluginManager patch 和 test DB 初始化逻辑；如果核心导出需要项目参数，则只保留项目参数桥接。
- 测试：
  - `packages/module-tenant/src/server/__tests__/tenant-import.test.ts`
  - `packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts`
  - `packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts`
  - `packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts`

### `tego` 核心仓库

- 创建：`packages/test/src/server/setupTestEnvironment.ts`
  - 职责：提供参数化 server test environment setup，封装临时 SQLite、`APP_ENV=test`、`PLUGIN_PATHS`、workspace plugin source loading、禁用 runtime/other plugins。
- 修改：`packages/test/setup/server.ts`
  - 职责：调用新的 `setupServerTestEnvironment()`，保持核心仓库默认 server setup 行为。
- 修改：`packages/test/vitest.ts`
  - 职责：导出 `defineTegoVitestConfig(options)` 配置工厂，同时保留默认导出兼容现有 `import config from '@tachybase/test/vitest'` 用法。
- 修改：`packages/test/src/server/index.ts`
  - 职责：导出 `setupServerTestEnvironment` 与相关类型。
- 修改：`packages/test/package.json`
  - 职责：如果需要新增子路径导出，添加稳定 exports；保留 `./vitest`。
- 创建：`packages/devkit/src/commands/test.ts`
  - 职责：注册 `tegod test`、`tegod test:server`、`tegod test:client`，明确调用 Vitest，不落入 app startup。
- 修改：`packages/devkit/src/commands/index.ts`
  - 职责：注册 test 命令。
- 测试：`packages/devkit/src/__tests__/test-command.test.ts`
  - 职责：覆盖 test 命令参数构造，避免未来又失去命令注册。
- 测试：`packages/test/src/__tests__/vitest-config.test.ts`
  - 职责：覆盖配置工厂、server setup 参数传递、默认导出兼容。

---

## 任务 1：稳定 `tego-standard` workflow date-field schedule 租户测试

**文件：**
- 修改：`d:/Dev/TegoJS/tego-standard/packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts:335-404`
- 验证：`d:/Dev/TegoJS/tego-standard/packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts`

- [ ] **步骤 1：复现整文件间歇失败**

运行：

```bash
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
```

预期：如果落在失败窗口，出现：

```text
FAIL packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts > workflow > triggers > schedule > date field mode > configuration > should persist tenant context for tenant-scoped records
AssertionError: expected +0 to be 1
```

同时运行孤立测试：

```bash
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts -t "should persist tenant context for tenant-scoped records"
```

预期：PASS。该结果证明失败来自整文件的时间窗口或共享调度状态，不是租户上下文断言本身必然失败。

- [ ] **步骤 2：把硬编码等待改为条件等待**

在 `mode-date-field.test.ts` 顶部 `sleepToEvenSecond()` 后添加 helper：

```ts
async function waitForExecutions(workflow, expected: number, timeout = 6000) {
  const startedAt = Date.now();
  let executions = [];

  while (Date.now() - startedAt < timeout) {
    executions = await workflow.getExecutions();
    if (executions.length === expected) {
      return executions;
    }
    await sleep(200);
  }

  return executions;
}
```

将租户测试中的：

```ts
await sleep(2000);

const executions = await workflow.getExecutions();
expect(executions.length).toBe(1);
```

替换为：

```ts
const executions = await waitForExecutions(workflow, 1);
expect(executions.length).toBe(1);
```

- [ ] **步骤 3：运行目标测试验证通过**

运行：

```bash
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
```

预期：

```text
Test Files  1 passed (1)
Tests       12 passed (12)
```

- [ ] **步骤 4：运行 `tego-standard` 当前关键测试**

运行：

```bash
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
```

预期：三个命令均 PASS。

- [ ] **步骤 5：Commit**

运行：

```bash
git add packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts
git commit -m "test(workflow): stabilize date schedule tenant test"
```

---

## 任务 2：在 `tego` 核心抽出参数化 server test environment setup

**文件：**
- 创建：`d:/Dev/TegoJS/tego/packages/test/src/server/setupTestEnvironment.ts`
- 修改：`d:/Dev/TegoJS/tego/packages/test/setup/server.ts:1-18`
- 修改：`d:/Dev/TegoJS/tego/packages/test/src/server/index.ts:1-9`
- 测试：`d:/Dev/TegoJS/tego/packages/test/src/__tests__/server-test-environment.test.ts`

- [ ] **步骤 1：编写失败的核心测试**

创建 `packages/test/src/__tests__/server-test-environment.test.ts`：

```ts
import path from 'node:path';

import TachybaseGlobal from '@tachybase/globals';
import { describe, expect, it } from 'vitest';

import { setupServerTestEnvironment } from '../server/setupTestEnvironment';

describe('setupServerTestEnvironment', () => {
  it('configures an isolated sqlite test environment', async () => {
    setupServerTestEnvironment({
      workspaceRoot: process.cwd(),
      pluginPaths: [path.resolve(process.cwd(), 'packages')],
      disableRuntimePlugins: true,
      disableOtherPlugins: true,
    });

    expect(TachybaseGlobal.settings.env.APP_ENV).toBe('test');
    expect(TachybaseGlobal.settings.logger.level).toBe('error');
    expect(TachybaseGlobal.settings.database.storage).toContain('tego-test');
    expect(TachybaseGlobal.settings.presets.runtimePlugins).toEqual([]);
    expect(TachybaseGlobal.getInstance().get('PLUGIN_PATHS')).toEqual([path.resolve(process.cwd(), 'packages')]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
pnpm exec vitest run packages/test/src/__tests__/server-test-environment.test.ts --config vitest.config.ts
```

预期：FAIL，报错包含：

```text
No export named setupServerTestEnvironment
```

或：

```text
Cannot find module '../server/setupTestEnvironment'
```

- [ ] **步骤 3：实现 `setupServerTestEnvironment`**

创建 `packages/test/src/server/setupTestEnvironment.ts`：

```ts
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import TachybaseGlobal from '@tachybase/globals';

export interface ServerTestEnvironmentOptions {
  workspaceRoot?: string;
  pluginPaths?: string[];
  packageDirByPluginName?: Record<string, string>;
  disableRuntimePlugins?: boolean;
  disableOtherPlugins?: boolean;
}

const require = createRequire(import.meta.url);

function createTestDbStorage() {
  const testDbName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  return path.join(os.tmpdir(), 'tego-test', testDbName);
}

function workspacePackageNameByShortName(workspaceRoot: string, name: string, map: Record<string, string>) {
  const candidates = [map[name], `module-${name}`, `plugin-${name}`].filter(Boolean);
  for (const packageDir of candidates) {
    const packageJsonPath = path.resolve(workspaceRoot, 'packages', packageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = require(packageJsonPath);
      return packageJson.name;
    }
  }
  return null;
}

function workspacePackageDirByPackageName(workspaceRoot: string, packageName?: string) {
  if (!packageName) {
    return null;
  }

  const packageDir = packageName.replace('@tachybase/', '');
  const packageJsonPath = path.resolve(workspaceRoot, 'packages', packageDir, 'package.json');
  return fs.existsSync(packageJsonPath) ? packageDir : null;
}

function patchPluginRuntime(core: any, workspaceRoot: string) {
  if (core.Plugin.prototype.__serverTestEnvironmentPatched) {
    return;
  }

  const originalLoadCollections = core.Plugin.prototype.loadCollections;

  core.Plugin.prototype.loadCollections = async function loadWorkspaceCollections() {
    const packageDir = this.options?.workspaceSource
      ? workspacePackageDirByPackageName(workspaceRoot, this.options?.packageName)
      : null;
    if (!packageDir) {
      return originalLoadCollections.call(this);
    }

    const directory = path.resolve(workspaceRoot, 'packages', packageDir, 'src/server/collections');
    if (!fs.existsSync(directory)) {
      return;
    }

    await this.db.import({
      directory,
      from: this.options.packageName,
    });
  };

  core.Plugin.prototype.__serverTestEnvironmentPatched = true;
}

function patchPluginManager(core: any, options: Required<Pick<ServerTestEnvironmentOptions, 'packageDirByPluginName'>> & ServerTestEnvironmentOptions) {
  const PluginManager = core.PluginManager;
  if (PluginManager.__serverTestEnvironmentPatched) {
    return;
  }

  const workspaceRoot = options.workspaceRoot || process.cwd();
  const resolvePlugin = PluginManager.resolvePlugin.bind(PluginManager);
  const workspaceSourcePackages = new Set<string>();

  PluginManager.getPackageName = async (name: string) =>
    workspacePackageNameByShortName(workspaceRoot, name, options.packageDirByPluginName) || name;

  PluginManager.getPackageJson = async (packageName: string) => {
    const packageDir = workspacePackageDirByPackageName(workspaceRoot, packageName);
    if (packageDir) {
      return require(path.resolve(workspaceRoot, 'packages', packageDir, 'package.json'));
    }
    return require(require.resolve(path.join(packageName, 'package.json')));
  };

  PluginManager.resolvePlugin = async (pluginName: any, isUpgrade = false, isPkg = false) => {
    if (typeof pluginName !== 'string') {
      return pluginName;
    }

    const packageName = isPkg ? pluginName : await PluginManager.getPackageName(pluginName);
    const packageDir = workspaceSourcePackages.has(packageName)
      ? workspacePackageDirByPackageName(workspaceRoot, packageName)
      : null;
    if (!packageDir) {
      return resolvePlugin(pluginName, isUpgrade, isPkg);
    }

    const pluginModule = await import(pathToFileURL(path.resolve(workspaceRoot, 'packages', packageDir, 'src/server/index.ts')).href);
    return pluginModule.default;
  };

  if (options.disableRuntimePlugins) {
    PluginManager.prototype.initRuntimePlugins = async function initNoRuntimePlugins() {
      this['_initRuntimePlugins'] = true;
    };
  }

  if (options.disableOtherPlugins) {
    PluginManager.prototype.initOtherPlugins = async function initNoOtherPlugins() {
      this['_initOtherPlugins'] = true;
    };
  }

  PluginManager.prototype.initPresetPlugins = async function initWorkspacePresetPlugins() {
    if (this['_initPresetPlugins']) {
      return;
    }

    for (const plugin of this.options.plugins || []) {
      const [pluginName, pluginOptions = {}] = Array.isArray(plugin) ? plugin : [plugin];
      const packageName =
        typeof pluginName === 'string'
          ? workspacePackageNameByShortName(workspaceRoot, pluginName, options.packageDirByPluginName)
          : null;
      if (packageName) {
        workspaceSourcePackages.add(packageName);
        await this.add(pluginName, { enabled: true, ...pluginOptions, packageName, workspaceSource: true });
      } else if (typeof pluginName === 'function') {
        await this.add(pluginName, { enabled: true, ...pluginOptions });
      } else {
        await this.add(pluginName, { enabled: true, isPreset: true, ...pluginOptions });
      }
    }

    this['_initPresetPlugins'] = true;
  };

  PluginManager.__serverTestEnvironmentPatched = true;
}

export function setupServerTestEnvironment(options: ServerTestEnvironmentOptions = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const pluginPaths = options.pluginPaths || [];
  const packageDirByPluginName = options.packageDirByPluginName || {};
  const settings = require('tego/presets/settings');

  TachybaseGlobal.settings = {
    ...settings,
    env: {
      ...settings.env,
      APP_ENV: 'test',
    },
    logger: {
      ...settings.logger,
      level: 'error',
    },
    database: {
      ...settings.database,
      storage: createTestDbStorage(),
    },
    presets: {
      ...settings.presets,
      runtimePlugins: options.disableRuntimePlugins ? [] : settings.presets.runtimePlugins,
    },
  };

  TachybaseGlobal.getInstance().set('PLUGIN_PATHS', pluginPaths);
  process.env.TEGO_RUNTIME_HOME = path.join(os.tmpdir(), 'test-sqlite');
  process.env.APP_ENV_PATH = process.env.APP_ENV_PATH || '.env.test';

  patchPluginRuntime(require('@tego/core'), workspaceRoot);
  patchPluginManager(require('@tego/core'), {
    ...options,
    workspaceRoot,
    packageDirByPluginName,
  });
}
```

- [ ] **步骤 4：接入默认 server setup 和导出**

将 `packages/test/setup/server.ts` 改为：

```ts
import path from 'node:path';
import { initEnv } from '@tego/devkit';

import { setupServerTestEnvironment } from '../src/server/setupTestEnvironment';

setupServerTestEnvironment({
  workspaceRoot: process.cwd(),
  pluginPaths: [path.resolve(process.cwd(), 'packages')],
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
});

initEnv();
```

在 `packages/test/src/server/index.ts` 增加：

```ts
export * from './setupTestEnvironment';
```

- [ ] **步骤 5：运行核心测试验证通过**

运行：

```bash
pnpm exec vitest run packages/test/src/__tests__/server-test-environment.test.ts --config vitest.config.ts
pnpm exec vitest run packages/core/src/__tests__/app.test.ts packages/test/src/__tests__/omitSomeFields.test.ts --config vitest.config.ts
```

预期：两个命令均 PASS。

- [ ] **步骤 6：Commit**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
git add packages/test/src/server/setupTestEnvironment.ts packages/test/setup/server.ts packages/test/src/server/index.ts packages/test/src/__tests__/server-test-environment.test.ts
git commit -m "test: add reusable server test environment setup"
```

---

## 任务 3：在核心 `@tachybase/test/vitest` 导出配置工厂

**文件：**
- 修改：`d:/Dev/TegoJS/tego/packages/test/vitest.ts:1-118`
- 测试：`d:/Dev/TegoJS/tego/packages/test/src/__tests__/vitest-config.test.ts`

- [ ] **步骤 1：编写失败的配置工厂测试**

创建 `packages/test/src/__tests__/vitest-config.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import defaultConfig, { defineTegoVitestConfig } from '../../vitest';

describe('defineTegoVitestConfig', () => {
  it('keeps the default export compatible', () => {
    expect(defaultConfig.test?.projects).toHaveLength(2);
  });

  it('accepts server setup options for external workspaces', () => {
    const config = defineTegoVitestConfig({
      server: {
        setupOptions: {
          workspaceRoot: '/workspace/app',
          pluginPaths: ['/workspace/app/packages'],
          packageDirByPluginName: {
            users: 'module-user',
          },
          disableRuntimePlugins: true,
          disableOtherPlugins: true,
        },
      },
    });

    expect(config.test?.projects).toHaveLength(2);
    expect(config.test?.alias).toEqual(expect.any(Array));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
pnpm exec vitest run packages/test/src/__tests__/vitest-config.test.ts --config vitest.config.ts
```

预期：FAIL，报错包含：

```text
No export named defineTegoVitestConfig
```

- [ ] **步骤 3：改造 `packages/test/vitest.ts`**

在 `packages/test/vitest.ts` 中保留现有 alias 逻辑，并把最终 `defineConfig({...})` 包装成函数：

```ts
export interface TegoVitestConfigOptions {
  server?: {
    setupFile?: string;
  };
}

export function defineTegoVitestConfig(options: TegoVitestConfigOptions = {}) {
  const serverSetupFile = options.server?.setupFile || resolve(__dirname, './setup/server.ts');

  return defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json-summary', 'json'],
        reportOnFailure: true,
        thresholds: {
          lines: 60,
          branches: 60,
          functions: 80,
          statements: 80,
        },
      },
      silent: !!process.env.GITHUB_ACTIONS,
      globals: true,
      alias: tsConfigPathsToAlias(),
      projects: [
        {
          root: process.cwd(),
          resolve: {
            mainFields: ['module'],
          },
          extends: true,
          test: {
            setupFiles: serverSetupFile,
            include: ['packages/**/__tests__/**/*.test.ts', 'apps/**/__tests__/**/*.test.ts'],
            exclude: [
              '**/node_modules/**',
              '**/dist/**',
              '**/lib/**',
              '**/es/**',
              '**/e2e/**',
              '**/__e2e__/**',
              '**/{vitest,commitlint}.config.*',
              'packages/**/{sdk,client,schema,components}/**/__tests__/**/*.{test,spec}.{ts,tsx}',
            ],
          },
        },
        {
          // @ts-ignore
          plugins: [react()],
          resolve: {
            mainFields: ['module'],
          },
          define: {
            'process.env.__TEST__': true,
            'process.env.__E2E__': false,
          },
          test: {
            globals: true,
            setupFiles: resolve(__dirname, './setup/client.ts'),
            environment: 'jsdom',
            css: false,
            alias: tsConfigPathsToAlias(),
            include: ['packages/**/{sdk,client,schema,components}/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
            exclude: [
              '**/node_modules/**',
              '**/dist/**',
              '**/lib/**',
              '**/es/**',
              '**/e2e/**',
              '**/__e2e__/**',
              '**/{vitest,commitlint}.config.*',
            ],
          },
        },
      ],
    },
  });
}

export default defineTegoVitestConfig();
```

如果 `setupOptions` 不能直接传给 setup file，保持 `setupFile` 参数即可；`tego-standard` 可提供自己的薄 setup file 调用 `setupServerTestEnvironment(options)`。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm exec vitest run packages/test/src/__tests__/vitest-config.test.ts --config vitest.config.ts
pnpm test -- --run packages/test/src/__tests__/vitest-config.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
git add packages/test/vitest.ts packages/test/src/__tests__/vitest-config.test.ts
git commit -m "test: expose reusable vitest config factory"
```

---

## 任务 4：在 devkit 注册明确的 test 命令

**文件：**
- 创建：`d:/Dev/TegoJS/tego/packages/devkit/src/commands/test.ts`
- 修改：`d:/Dev/TegoJS/tego/packages/devkit/src/commands/index.ts:1-31`
- 测试：`d:/Dev/TegoJS/tego/packages/devkit/src/__tests__/test-command.test.ts`

- [ ] **步骤 1：编写失败的命令注册测试**

创建 `packages/devkit/src/__tests__/test-command.test.ts`：

```ts
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import registerTestCommand from '../commands/test';

describe('devkit test commands', () => {
  it('registers test, test:server, and test:client commands', () => {
    const cli = new Command();

    registerTestCommand(cli);

    expect(cli.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['test', 'test:server', 'test:client']));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
pnpm exec vitest run packages/devkit/src/__tests__/test-command.test.ts --config vitest.config.ts
```

预期：FAIL，报错包含：

```text
Cannot find module '../commands/test'
```

- [ ] **步骤 3：实现 test 命令**

创建 `packages/devkit/src/commands/test.ts`：

```ts
import { Command } from 'commander';
import { execa } from 'execa';

function runVitest(args: string[]) {
  return execa('pnpm', ['exec', 'vitest', ...args], {
    shell: true,
    stdio: 'inherit',
  });
}

export default function test(cli: Command) {
  cli
    .command('test')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description('Run Vitest tests')
    .action(async (_, command: Command) => {
      await runVitest(command.args);
    });

  cli
    .command('test:server')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description('Run server Vitest tests')
    .action(async (_, command: Command) => {
      await runVitest(['--project', '0', ...command.args]);
    });

  cli
    .command('test:client')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description('Run client Vitest tests')
    .action(async (_, command: Command) => {
      await runVitest(['--project', '1', ...command.args]);
    });
}
```

如果 Vitest project 名称在后续实现中被显式命名为 `server` / `client`，则把 `--project 0` 和 `--project 1` 改成 `--project server` / `--project client`，并同步更新测试断言。

- [ ] **步骤 4：注册命令**

修改 `packages/devkit/src/commands/index.ts`：

```ts
import test from './test';
```

在默认导出函数内 `e2e(cli);` 后添加：

```ts
test(cli);
```

- [ ] **步骤 5：运行核心命令测试**

运行：

```bash
pnpm exec vitest run packages/devkit/src/__tests__/test-command.test.ts --config vitest.config.ts
pnpm test -- --run packages/devkit/src/__tests__/test-command.test.ts
```

预期：PASS。

- [ ] **步骤 6：手动验证命令不落入 app startup**

运行：

```bash
pnpm tegod test:server -- --run packages/test/src/__tests__/vitest-config.test.ts
```

预期：命令输出 Vitest `RUN`，并执行测试；不应出现：

```text
SQLITE_ERROR: no such table: applicationPlugins
```

- [ ] **步骤 7：Commit**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
git add packages/devkit/src/commands/test.ts packages/devkit/src/commands/index.ts packages/devkit/src/__tests__/test-command.test.ts
git commit -m "fix(devkit): run vitest from test commands"
```

---

## 任务 5：让 `tego-standard` 复用核心配置并保留项目薄 setup

**文件：**
- 修改：`d:/Dev/TegoJS/tego-standard/vitest.config.mts:1-142`
- 修改：`d:/Dev/TegoJS/tego-standard/vitest.setup.server.ts:1-176`
- 验证：`d:/Dev/TegoJS/tego-standard` 的关键测试

- [ ] **步骤 1：用本地核心包重定向依赖**

优先尝试 link：

```bash
pnpm --dir d:/Dev/TegoJS/tego --filter @tachybase/test build
pnpm --dir d:/Dev/TegoJS/tego --filter @tego/devkit build
pnpm --dir d:/Dev/TegoJS/tego-standard link d:/Dev/TegoJS/tego/packages/test
pnpm --dir d:/Dev/TegoJS/tego-standard link d:/Dev/TegoJS/tego/packages/devkit
```

如果 link 后 `pnpm exec vitest --version` 或 import 解析失败，改用 tarball：

```bash
pnpm --dir d:/Dev/TegoJS/tego --filter @tachybase/test pack --pack-destination d:/Dev/TegoJS/tego/.packs
pnpm --dir d:/Dev/TegoJS/tego --filter @tego/devkit pack --pack-destination d:/Dev/TegoJS/tego/.packs
pnpm --dir d:/Dev/TegoJS/tego-standard add -D d:/Dev/TegoJS/tego/.packs/tachybase-test-1.6.12.tgz d:/Dev/TegoJS/tego/.packs/tego-devkit-1.6.12.tgz
```

- [ ] **步骤 2：收窄 `vitest.setup.server.ts`**

将 `vitest.setup.server.ts` 改为：

```ts
import path from 'node:path';

import { setupServerTestEnvironment } from '@tachybase/test/server';
import { initEnv } from '@tego/devkit';

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

initEnv();
```

如果核心没有新增 `@tachybase/test/server` 子路径导出，则改为：

```ts
import { setupServerTestEnvironment } from '@tachybase/test';
```

并在核心 `packages/test/src/index.ts` 导出该函数。

- [ ] **步骤 3：收窄 `vitest.config.mts`**

将 `vitest.config.mts` 改为：

```ts
import path from 'node:path';

import { defineTegoVitestConfig } from '@tachybase/test/vitest';

export default defineTegoVitestConfig({
  server: {
    setupFile: path.resolve(process.cwd(), './vitest.setup.server.ts'),
  },
});
```

如果 `node-xlsx` 或 `packages/module-auth/src/constants` 的 alias 仍因外部依赖解析失败需要保留，则只保留这些项目特有 alias，不再复制核心 alias 和 test projects 定义。

- [ ] **步骤 4：运行 `tego-standard` 关键测试**

运行：

```bash
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
```

预期：三个命令均 PASS。

- [ ] **步骤 5：验证 `pnpm test:server`**

运行：

```bash
pnpm test:server -- --run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts
```

预期：命令输出 Vitest `RUN`，并执行目标测试；不应读取空 `.env.test` 启动 app，也不应出现 `applicationPlugins` 缺表。

- [ ] **步骤 6：记录本地重定向方法**

在最终回复中记录实际可用方式。如果 link 成功，记录：

```bash
pnpm --dir d:/Dev/TegoJS/tego-standard link d:/Dev/TegoJS/tego/packages/test
pnpm --dir d:/Dev/TegoJS/tego-standard link d:/Dev/TegoJS/tego/packages/devkit
```

如果 tarball 成功，记录实际 tarball 文件名和命令。

- [ ] **步骤 7：Commit**

在 `d:/Dev/TegoJS/tego-standard` 运行：

```bash
git add vitest.config.mts vitest.setup.server.ts
git commit -m "test: reuse core vitest server setup"
```

---

## 任务 6：最终跨仓库验证与收尾

**文件：**
- 验证：`d:/Dev/TegoJS/tego`
- 验证：`d:/Dev/TegoJS/tego-standard`

- [ ] **步骤 1：检查两个仓库 git 状态**

运行：

```bash
git -C d:/Dev/TegoJS/tego status --short
git -C d:/Dev/TegoJS/tego-standard status --short
```

预期：只有已知未提交文件；如果任务 1-5 已提交，两个仓库应干净。

- [ ] **步骤 2：运行核心验证**

在 `d:/Dev/TegoJS/tego` 运行：

```bash
pnpm exec vitest run packages/test/src/__tests__/server-test-environment.test.ts packages/test/src/__tests__/vitest-config.test.ts packages/devkit/src/__tests__/test-command.test.ts --config vitest.config.ts
pnpm test -- --run packages/core/src/__tests__/app.test.ts packages/test/src/__tests__/omitSomeFields.test.ts
pnpm tegod test:server -- --run packages/test/src/__tests__/vitest-config.test.ts
```

预期：全部 PASS，且 `tegod test:server` 走 Vitest。

- [ ] **步骤 3：运行业务仓库验证**

在 `d:/Dev/TegoJS/tego-standard` 运行：

```bash
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-import.test.ts packages/module-tenant/src/server/__tests__/set-current-tenant.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts --config vitest.config.mts
pnpm exec vitest run packages/module-workflow/src/server/__tests__/triggers/schedule/mode-date-field.test.ts --config vitest.config.mts
pnpm test:server -- --run packages/module-tenant/src/server/__tests__/tenant-resource-guard.test.ts
```

预期：全部 PASS。

- [ ] **步骤 4：整理提交清单**

运行：

```bash
git -C d:/Dev/TegoJS/tego log --oneline -5
git -C d:/Dev/TegoJS/tego-standard log --oneline -5
```

最终回复列出两个仓库各自新增 commit，以及核心本地重定向测试方法。

---

## 自检结果

- 规格覆盖度：计划覆盖了 `tego-standard` 现有测试稳定、`@tachybase/test` server setup 上移、Vitest 配置工厂、`tegod test:server` 明确命令、业务仓库薄配置、本地重定向验证。
- 占位符扫描：计划没有使用“待定”、“TODO”、“后续补充”等占位说明；每个实现任务都有具体文件、代码片段、命令和预期。
- 类型一致性：配置工厂统一使用 `defineTegoVitestConfig({ server: { setupFile } })`；server 环境初始化统一使用 `setupServerTestEnvironment(options)`；业务仓库薄 setup 调用同一函数。
