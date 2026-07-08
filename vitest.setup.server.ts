import fs from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { setupServerTestEnvironment } from '@tachybase/test/setup-server';
import { initEnv } from '@tego/devkit';

// jsonwebtoken@8 pulls in buffer-equal-constant-time, which still references
// SlowBuffer.prototype during module initialization. Node 26 no longer exposes
// SlowBuffer, so provide the Buffer constructor for test compatibility.
const require = nodeModule.createRequire(import.meta.url);
const buffer = require('node:buffer');
buffer.SlowBuffer ??= buffer.Buffer;

const workspaceRoot = process.cwd();
const workspacePluginPaths = [path.resolve(workspaceRoot, 'packages')];
const packageDirByPluginName = {
  acl: 'module-acl',
  auth: 'module-auth',
  'collection-manager': 'module-collection',
  'data-source-manager': 'module-data-source',
  'error-handler': 'module-error-handler',
  'file-manager': 'module-file',
  'ui-schema-storage': 'module-ui-schema',
  users: 'module-user',
  workflow: 'module-workflow',
  'workflow-test': 'plugin-workflow-test',
  'audit-logs': 'plugin-audit-logs',
  'custom-request': 'plugin-action-custom-request',
  'localization-management': 'plugin-i18n-editor',
  'system-settings': 'module-app-info',
  oidc: 'plugin-auth-oidc',
  saml: 'plugin-auth-saml',
  'sms-auth': 'plugin-auth-sms',
  'api-keys': 'plugin-api-keys',
  map: 'plugin-block-map',
  'multi-app-manager': 'module-multi-app',
  'snapshot-field': 'plugin-field-snapshot',
  'sequence-field': 'plugin-field-sequence',
  'china-region': 'plugin-field-china-region',
  verification: 'plugin-otp',
  'evaluator-mathjs': 'plugin-evaluator-mathjs',
};

// Workspace dist files are CommonJS and bypass Vitest aliases, so keep their
// core/server imports on the same runtime instance used by @tachybase/test.
const runtimeRequire = nodeModule.createRequire(path.resolve(workspaceRoot, 'package.json'));
const testRequire = nodeModule.createRequire(path.resolve(workspaceRoot, 'node_modules/@tachybase/test/package.json'));
const runtimeResolutions = new Map([
  ['@tego/server', testRequire.resolve('@tego/server')],
  ['@tego/server/package.json', testRequire.resolve('@tego/server/package.json')],
  ['@tego/core', testRequire.resolve('@tego/core')],
  ['@tego/core/package.json', testRequire.resolve('@tego/core/package.json')],
]);
const resolverPatched = Symbol.for('tego-standard.server-test-runtime-resolver-patched');

type CommonJsModuleWithResolver = typeof nodeModule.Module & {
  _resolveFilename: (request: string, ...args: unknown[]) => string;
  [resolverPatched]?: true;
};

const commonJsModule = nodeModule.Module as CommonJsModuleWithResolver;

if (!commonJsModule[resolverPatched]) {
  const originalResolveFilename = commonJsModule._resolveFilename;

  commonJsModule._resolveFilename = function resolveTestRuntime(this: unknown, request: string, ...args: unknown[]) {
    return runtimeResolutions.get(request) || originalResolveFilename.call(this, request, ...args);
  };
  commonJsModule[resolverPatched] = true;
}

function getTachybaseGlobal(requireFn: NodeJS.Require) {
  const tachybaseGlobalModule = requireFn('@tachybase/globals');
  return tachybaseGlobalModule.getInstance ? tachybaseGlobalModule : tachybaseGlobalModule.default;
}

function configureWorkerGlobals(requireFn: NodeJS.Require) {
  try {
    const tachybaseGlobal = getTachybaseGlobal(requireFn);
    tachybaseGlobal.getInstance().set('PLUGIN_PATHS', workspacePluginPaths);
    tachybaseGlobal.getInstance().set('WORKER_PATHS', [workspaceRoot, ...workspacePluginPaths]);
    tachybaseGlobal.getInstance().set('WORKER_MODULES', []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
}

const runtimeGlobalRequires = [runtimeRequire, testRequire];
for (const packageName of ['@tego/core', '@tego/server']) {
  for (const requireFn of [runtimeRequire, testRequire]) {
    try {
      runtimeGlobalRequires.push(nodeModule.createRequire(requireFn.resolve(`${packageName}/package.json`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }
}

for (const requireFn of runtimeGlobalRequires) {
  configureWorkerGlobals(requireFn);
}

function workspacePackageDirByPackageName(packageName?: string) {
  if (!packageName) {
    return null;
  }

  const mappedPackageDir = Object.values(packageDirByPluginName).find((packageDir) => {
    const packageJsonPath = path.resolve(workspaceRoot, 'packages', packageDir, 'package.json');
    return fs.existsSync(packageJsonPath) && runtimeRequire(packageJsonPath).name === packageName;
  });
  if (mappedPackageDir) {
    return mappedPackageDir;
  }

  const packageDir = packageName.replace('@tachybase/', '');
  const packageJsonPath = path.resolve(workspaceRoot, 'packages', packageDir, 'package.json');
  return fs.existsSync(packageJsonPath) ? packageDir : null;
}

const workspaceMigrationsPatched = Symbol.for('tego-standard.server-test-workspace-migrations-patched');

type PluginWithWorkspaceMigrationPatch = {
  loadMigrations: () => Promise<unknown>;
  options?: {
    packageName?: string;
    workspaceSource?: boolean;
  };
  app: {
    loadMigrations: (options: unknown) => Promise<unknown>;
  };
  [workspaceMigrationsPatched]?: true;
};

function patchWorkspaceMigrations(core: any) {
  const pluginPrototype = core?.Plugin?.prototype as PluginWithWorkspaceMigrationPatch | undefined;
  if (!pluginPrototype || pluginPrototype[workspaceMigrationsPatched]) {
    return;
  }

  const originalLoadMigrations = pluginPrototype.loadMigrations;
  pluginPrototype.loadMigrations = async function loadWorkspaceMigrations(this: PluginWithWorkspaceMigrationPatch) {
    const packageDir = this.options?.workspaceSource
      ? workspacePackageDirByPackageName(this.options?.packageName)
      : null;
    if (!packageDir) {
      return originalLoadMigrations.call(this);
    }

    const sourceDirectory = path.resolve(workspaceRoot, 'packages', packageDir, 'src/server/migrations');
    const compiledDirectory = path.resolve(workspaceRoot, 'packages', packageDir, 'dist/server/migrations');
    const directory = fs.existsSync(compiledDirectory) ? compiledDirectory : sourceDirectory;
    if (!fs.existsSync(directory)) {
      return { beforeLoad: [], afterSync: [], afterLoad: [] };
    }

    return this.app.loadMigrations({
      directory: directory.replace(/\\/g, '/'),
      namespace: this.options?.packageName,
      context: {
        plugin: this,
      },
    });
  };
  pluginPrototype[workspaceMigrationsPatched] = true;
}

function getCoreModules() {
  const coreModules: unknown[] = [];
  const addCore = (loader: () => unknown) => {
    try {
      coreModules.push(loader());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
  };

  addCore(() => testRequire('@tego/core'));
  addCore(() => runtimeRequire('@tego/core'));
  addCore(() => testRequire('@tego/server'));
  addCore(() => runtimeRequire('@tego/server'));
  addCore(() => nodeModule.createRequire(testRequire.resolve('@tego/server/package.json'))('@tego/core'));
  addCore(() => nodeModule.createRequire(runtimeRequire.resolve('@tego/server/package.json'))('@tego/core'));

  return [...new Set(coreModules)];
}

setupServerTestEnvironment({
  workspaceRoot,
  pluginPaths: workspacePluginPaths,
  packageDirByPluginName,
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
});

for (const core of getCoreModules()) {
  patchWorkspaceMigrations(core);
}

initEnv();
