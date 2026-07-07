import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { patchCjsResolverForTestRuntime, setupServerTestEnvironment } from '@tachybase/test/setup-server';
import { PluginManager } from '@tego/core';
import { initEnv } from '@tego/devkit';

import { require as tsxRequire } from 'tsx/cjs/api';

import { installVitestConsoleOutputFilter } from './vitest.console-filter';

installVitestConsoleOutputFilter();

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

const workspaceRoot = process.cwd();
const pluginPaths = [path.resolve(workspaceRoot, 'packages')];
const runtimeRequire = createRequire(path.resolve(workspaceRoot, 'package.json'));
const testPackageRequire = createRequire(runtimeRequire.resolve('@tachybase/test/package.json'));
const databasePackageJsonPath = testPackageRequire.resolve('@tachybase/database/package.json');
const databasePackageRequire = createRequire(databasePackageJsonPath);
const databasePackageRoot = path.dirname(databasePackageJsonPath);
const collectionImporter = databasePackageRequire(path.resolve(databasePackageRoot, 'lib/collection-importer.js'));
const lodash = databasePackageRequire('lodash');
const workspacePluginNameAliases = {
  map: 'block-map',
};
const testUnsafeBuiltinPlugins = new Set(['event-source', 'worker-thread']);

const serverTestEnvironmentOptions = {
  workspaceRoot,
  pluginPaths,
  packageDirByPluginName,
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
};

function getModuleDefault(mod: any) {
  return mod?.default?.default || mod?.default || mod;
}

function workspacePackageNameByShortName(name: string, map: Record<string, string>) {
  const normalizedName = workspacePluginNameAliases[name] || name;
  const candidates = [map[name], map[normalizedName], `module-${normalizedName}`, `plugin-${normalizedName}`].filter(
    Boolean,
  );

  for (const packageDir of candidates) {
    const packageJsonPath = path.resolve(workspaceRoot, 'packages', packageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return runtimeRequire(packageJsonPath).name;
    }
  }

  return null;
}

function workspacePackageDirByPackageName(packageName: string, map: Record<string, string>) {
  if (!packageName) {
    return null;
  }

  const mappedPackageDir = Object.values(map).find((packageDir) => {
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

function workspaceServerEntry(packageDir: string) {
  const sourceEntry = path.resolve(workspaceRoot, 'packages', packageDir, 'src/server/index.ts');
  if (fs.existsSync(sourceEntry)) {
    return sourceEntry;
  }

  const libEntry = path.resolve(workspaceRoot, 'packages', packageDir, 'lib/server/index.js');
  if (fs.existsSync(libEntry)) {
    return libEntry;
  }

  const distEntry = path.resolve(workspaceRoot, 'packages', packageDir, 'dist/server/index.js');
  if (fs.existsSync(distEntry)) {
    return distEntry;
  }

  return null;
}

function loadWorkspaceServerPlugin(packageName: string) {
  const packageDir = workspacePackageDirByPackageName(packageName, packageDirByPluginName);
  const entry = packageDir ? workspaceServerEntry(packageDir) : null;
  if (!entry) {
    return null;
  }

  return getModuleDefault(tsxRequire(entry, path.resolve(workspaceRoot, 'package.json')));
}

function installTsxWorkspacePluginLoader() {
  const pluginManager = PluginManager as any;
  if (pluginManager.__serverTestEnvironmentTsxLoaderPatched) {
    return;
  }

  const originalAdd = pluginManager.prototype.add;

  pluginManager.prototype.add = async function addWorkspaceSourcePluginWithTsx(
    plugin: any,
    pluginOptions: any = {},
    insert = false,
    isUpgrade = false,
  ) {
    if (typeof plugin === 'string' && pluginOptions?.workspaceSource && pluginOptions?.packageName) {
      const PluginClass = loadWorkspaceServerPlugin(pluginOptions.packageName);
      if (PluginClass) {
        return originalAdd.call(this, PluginClass, pluginOptions, insert, isUpgrade);
      }
    }

    return originalAdd.call(this, plugin, pluginOptions, insert, isUpgrade);
  };

  pluginManager.prototype.initPresetPlugins = async function initWorkspacePresetPluginsWithTsx() {
    if (this['_initPresetPlugins']) {
      return;
    }

    const addWorkspacePlugin = async (pluginName: any, pluginOptions: any = {}) => {
      const normalizedPluginName =
        typeof pluginName === 'string' ? workspacePluginNameAliases[pluginName] || pluginName : pluginName;
      const packageName =
        typeof pluginName === 'string' ? workspacePackageNameByShortName(pluginName, packageDirByPluginName) : null;

      if (packageName) {
        const PluginClass = loadWorkspaceServerPlugin(packageName);
        if (PluginClass) {
          await this.add(PluginClass, {
            name: pluginName,
            ...pluginOptions,
            packageName,
            workspaceSource: true,
          });
          return;
        }

        await this.add(normalizedPluginName, {
          name: pluginName,
          ...pluginOptions,
          packageName,
          workspaceSource: true,
        });
        return;
      }

      if (typeof pluginName === 'function') {
        await this.add(pluginName, pluginOptions);
        return;
      }

      await this.add(normalizedPluginName, { name: pluginName, isPreset: true, ...pluginOptions });
    };

    const addTachybasePresetPlugin = async (pluginName: string, pluginOptions: any = {}) => {
      if (testUnsafeBuiltinPlugins.has(pluginName)) {
        return;
      }
      await addWorkspacePlugin(pluginName, { enabled: true, ...pluginOptions });
    };

    const addTachybaseExternalPlugin = async (plugin: any, pluginOptions: any = {}) => {
      const pluginName = typeof plugin === 'string' ? plugin : plugin?.name;
      if (!pluginName || testUnsafeBuiltinPlugins.has(pluginName)) {
        return;
      }
      await addWorkspacePlugin(pluginName, { enabled: !!plugin?.enabledByDefault, ...pluginOptions });
    };

    for (const plugin of this.options.plugins || []) {
      const [pluginName, pluginOptions = {}] = Array.isArray(plugin) ? plugin : [plugin];
      if (pluginName === 'tachybase') {
        const currentSettings =
          pluginManager.__serverTestEnvironmentOptions?.settings ||
          pluginManager.__serverTestEnvironmentPatchOptions?.settings;
        for (const builtinPlugin of currentSettings?.presets?.builtinPlugins || []) {
          await addTachybasePresetPlugin(builtinPlugin, pluginOptions);
        }
        for (const externalPlugin of currentSettings?.presets?.externalPlugins || []) {
          await addTachybaseExternalPlugin(externalPlugin, pluginOptions);
        }
        continue;
      }

      await addWorkspacePlugin(pluginName, { enabled: true, ...pluginOptions });
    }

    this['_initPresetPlugins'] = true;
  };

  pluginManager.__serverTestEnvironmentTsxLoaderPatched = true;
}

function installTsxWorkspaceCollectionLoader() {
  const ImporterReader = collectionImporter.ImporterReader;
  if (ImporterReader.prototype.__serverTestEnvironmentTsxLoaderPatched) {
    return;
  }

  const originalRead = ImporterReader.prototype.read;
  const packagesRoot = path.resolve(workspaceRoot, 'packages') + path.sep;
  const sourceCollectionsSegment = `${path.sep}src${path.sep}server${path.sep}collections`;

  ImporterReader.prototype.read = async function readWorkspaceCollectionsWithTsx() {
    const directory = path.resolve(this.directory);
    if (!directory.startsWith(packagesRoot) || !directory.includes(sourceCollectionsSegment)) {
      return originalRead.call(this);
    }

    if (!fs.existsSync(directory)) {
      return [];
    }

    const files = await fs.promises.readdir(directory, {
      encoding: 'utf-8',
    });
    const modules = await Promise.all(
      files
        .filter((fileName: string) => {
          if (fileName.endsWith('.d.ts')) {
            return false;
          }
          const ext = path.parse(fileName).ext.replace('.', '');
          return this.extensions.has(ext);
        })
        .map(async (fileName: string) => {
          const filePath = path.join(directory, fileName);
          const mod = getModuleDefault(tsxRequire(filePath, path.resolve(workspaceRoot, 'package.json')));
          return typeof mod === 'function' ? mod() : mod;
        }),
    );

    return modules.filter((module: any) => lodash.isPlainObject(module)).map((module: any) => lodash.cloneDeep(module));
  };

  ImporterReader.prototype.__serverTestEnvironmentTsxLoaderPatched = true;
}

// Patch CJS resolver to keep @tego/server and @tego/core on the same runtime
// instance used by @tachybase/test (prevents dual-instance bugs in workspace
// dist files that bypass Vitest aliases).
patchCjsResolverForTestRuntime();

setupServerTestEnvironment(serverTestEnvironmentOptions);
installTsxWorkspacePluginLoader();
installTsxWorkspaceCollectionLoader();

initEnv();
