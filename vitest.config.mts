import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineTegoVitestConfig } from '@tachybase/test/vitest';

import type { Plugin } from 'vite';

import { shouldSuppressViteWarning, shouldSuppressVitestConsoleOutput } from './vitest.console-filter';

const sourceMappingURLRE = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/;
const reactZoomPanPinchDistFile = 'react-zoom-pan-pinch/dist/index.esm.js';

interface ViteLogOptions {
  error?: Error | null;
}

interface ViteLogger {
  info(message: string, options?: ViteLogOptions): void;
  warn(message: string, options?: ViteLogOptions): void;
  warnOnce(message: string, options?: ViteLogOptions): void;
  error(message: string, options?: ViteLogOptions): void;
  clearScreen(type: 'error' | 'warn' | 'info'): void;
  hasErrorLogged(error: Error): boolean;
  hasWarned: boolean;
}

interface ViteConfigWithCustomLogger {
  customLogger?: ViteLogger;
}

function cleanModuleId(id: string) {
  return id.replace(/[?#].*$/, '');
}

function normalizeModuleId(id: string) {
  return cleanModuleId(id).replace(/\\/g, '/');
}

function filePathFromId(id: string) {
  const filePath = cleanModuleId(id);
  if (/^\/[A-Za-z]:/.test(filePath)) {
    return filePath.slice(1);
  }
  if (filePath.startsWith('/node_modules/')) {
    return path.resolve(process.cwd(), `.${filePath}`);
  }
  if (filePath.startsWith('/@fs/')) {
    return filePath.slice('/@fs/'.length);
  }
  return filePath;
}

/**
 * 上游包的 sourcemap sourceRoot 路径错误或 sourcesContent 缺失，
 * 导致 Vite injectSourcesContent 打印 "points to missing source files" 警告。
 * 对已知直接从 dist 文件读取 map 的依赖，先在 load 阶段去掉 sourceMappingURL。
 * 其余已知问题包继续在 transform 阶段剥离 sourcemap。
 */
function stripBrokenSourcemaps(): Plugin {
  const brokenPkgs = [
    '@antv/scale/',
    '@antv/coord/',
    '@antv/g2-extension-plot/',
    '@antv/layout/',
    'react-zoom-pan-pinch/',
  ];
  return {
    name: 'strip-broken-sourcemaps',
    enforce: 'pre',
    async load(id) {
      if (normalizeModuleId(id).endsWith(reactZoomPanPinchDistFile)) {
        const code = await readFile(filePathFromId(id), 'utf-8');
        return { code: code.replace(sourceMappingURLRE, ''), map: null };
      }
    },
    transform(code, id) {
      if (brokenPkgs.some((pkg) => id.includes(pkg))) {
        return { code, map: null };
      }
    },
  };
}

const actionImportRequire = createRequire(path.resolve(process.cwd(), 'packages/plugin-action-import/package.json'));
const clientSetupFile = path.resolve(process.cwd(), './vitest.setup.client.ts');
const config = defineTegoVitestConfig({
  server: {
    setupFile: path.resolve(process.cwd(), './vitest.setup.server.ts'),
  },
  client: {
    setupFile: clientSetupFile,
  },
});

function withConsoleOutputFilter(existing?: (log: string, type: 'stdout' | 'stderr') => boolean | void) {
  return (log: string, type: 'stdout' | 'stderr') => {
    if (shouldSuppressVitestConsoleOutput(log, type)) {
      return false;
    }
    return existing?.(log, type);
  };
}

config.test.onConsoleLog = withConsoleOutputFilter(config.test.onConsoleLog);

function createConsoleViteLogger(): ViteLogger {
  const warnedMessages = new Set<string>();
  const loggedErrors = new WeakSet<Error>();
  const logger: ViteLogger = {
    hasWarned: false,
    info(message) {
      console.info(message);
    },
    warn(message) {
      logger.hasWarned = true;
      console.warn(message);
    },
    warnOnce(message, options) {
      if (warnedMessages.has(message)) {
        return;
      }
      warnedMessages.add(message);
      logger.warn(message, options);
    },
    error(message, options) {
      if (options?.error) {
        loggedErrors.add(options.error);
      }
      console.error(message);
    },
    clearScreen() {},
    hasErrorLogged(error) {
      return loggedErrors.has(error);
    },
  };
  return logger;
}

function withViteWarningFilter(logger: ViteLogger = createConsoleViteLogger()): ViteLogger {
  const originalWarn = logger.warn.bind(logger);
  const originalWarnOnce = logger.warnOnce.bind(logger);

  logger.warn = (message: string, options?: ViteLogOptions) => {
    if (shouldSuppressViteWarning(message)) {
      return;
    }
    return originalWarn(message, options);
  };
  logger.warnOnce = (message: string, options?: ViteLogOptions) => {
    if (shouldSuppressViteWarning(message)) {
      return;
    }
    return originalWarnOnce(message, options);
  };
  return logger;
}

function installViteWarningFilter(project: ViteConfigWithCustomLogger) {
  project.customLogger = withViteWarningFilter(project.customLogger);
}

installViteWarningFilter(config);

const workspaceServerAliases = [
  ['@tachybase/module-acl', 'module-acl'],
  ['@tachybase/module-auth', 'module-auth'],
  ['@tachybase/module-collection', 'module-collection'],
  ['@tachybase/module-data-source', 'module-data-source'],
  ['@tachybase/module-error-handler', 'module-error-handler'],
  ['@tachybase/module-ui-schema', 'module-ui-schema'],
  ['@tachybase/module-user', 'module-user'],
  ['@tachybase/module-workflow', 'module-workflow'],
  ['@tachybase/plugin-workflow', 'module-workflow'],
  ['@tachybase/plugin-workflow-test', 'plugin-workflow-test'],
  ['@tachybase/plugin-auth-oidc', 'plugin-auth-oidc'],
  ['@tachybase/plugin-auth-saml', 'plugin-auth-saml'],
  ['@tachybase/plugin-api-keys', 'plugin-api-keys'],
  ['@tachybase/plugin-evaluator-mathjs', 'plugin-evaluator-mathjs'],
].map(([packageName, packageDir]) => ({
  find: new RegExp(`^${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  replacement: path.resolve(process.cwd(), `packages/${packageDir}/src/server/index.ts`),
}));

const testRequire = createRequire(path.resolve(process.cwd(), 'node_modules/@tachybase/test/package.json'));
const testServerEntry = testRequire.resolve('@tego/server');
const testCoreEntry = testRequire.resolve('@tego/core');

const tegoServerRequire = createRequire(path.resolve(process.cwd(), 'packages/module-multi-app/package.json'));

// Resolve @tego/client sub-dependencies for vitest aliases
const tegoClientPkg = tegoServerRequire.resolve('@tego/client/package.json');
const tegoClientRequire = createRequire(tegoClientPkg);
const sdkEntry = tegoClientRequire.resolve('@tachybase/sdk');
const requirejsEntry = tegoClientRequire.resolve('@tachybase/requirejs');
const utilsClientEntry = tegoClientRequire.resolve('@tachybase/utils/client');
const componentsEntry = tegoClientRequire.resolve('@tachybase/components');
const evaluatorsClientEntry = tegoClientRequire.resolve('@tachybase/evaluators/client');

const projectAliases = [
  ...workspaceServerAliases,
  {
    find: '@tego/server',
    replacement: testServerEntry,
  },
  {
    find: '@tego/core',
    replacement: testCoreEntry,
  },
  {
    find: '@tachybase/sdk',
    replacement: sdkEntry,
  },
  {
    find: '@tachybase/requirejs',
    replacement: requirejsEntry,
  },
  {
    find: '@tachybase/utils/client',
    replacement: utilsClientEntry,
  },
  {
    find: '@tachybase/components',
    replacement: componentsEntry,
  },
  {
    find: '@tachybase/evaluators/client',
    replacement: evaluatorsClientEntry,
  },
  {
    // Force all @tachybase/schema imports to resolve to the same instance
    // to avoid reactive module instance mismatch between copies
    find: '@tachybase/schema',
    replacement: tegoClientRequire.resolve('@tachybase/schema'),
  },
  {
    find: 'node-xlsx',
    replacement: actionImportRequire.resolve('node-xlsx'),
  },
  {
    find: 'packages/module-auth/src/constants',
    replacement: path.resolve(process.cwd(), 'packages/module-auth/src/constants.ts'),
  },
  {
    find: '@tachybase/test/setup-server',
    replacement: testRequire.resolve('@tachybase/test/setup-server'),
  },
];

config.test.alias = [...projectAliases, ...(config.test.alias || [])];
for (const project of config.test.projects || []) {
  installViteWarningFilter(project);
  project.test.alias = [...projectAliases, ...(project.test.alias || [])];
  project.test.onConsoleLog = withConsoleOutputFilter(project.test.onConsoleLog);
  if (project.test.name === 'server') {
    // @tachybase/test ESM entry (es/index.mjs) uses createRequire which fails in vitest ESM context.
    // Force CJS entry for server tests.
    const testCjsEntry = testRequire.resolve('@tachybase/test');
    project.test.alias = [...(project.test.alias || []), { find: '@tachybase/test', replacement: testCjsEntry }];
    project.plugins = [stripBrokenSourcemaps(), ...(project.plugins || [])];
  }
  if (project.test.name === 'client') {
    project.test.testTimeout = 15000;
    project.plugins = [stripBrokenSourcemaps(), ...(project.plugins || [])];
  }
}

export default config;
