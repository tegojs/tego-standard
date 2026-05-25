import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const testPackageJson = require.resolve('@tachybase/test/package.json');
const testRequire = createRequire(testPackageJson);
const serverPackageJson = testRequire.resolve('@tego/server/package.json');
const serverRequire = createRequire(serverPackageJson);
const TachybaseGlobal = testRequire('@tachybase/globals').default;
const devkitRoot = path.resolve(path.dirname(require.resolve('@tego/devkit')), '..');
const { initEnv } = await import(pathToFileURL(path.resolve(devkitRoot, './lib/util.mjs')).href);
const defaultSettings = require('tego/presets/settings');
const testDbName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;

TachybaseGlobal.settings = {
  ...defaultSettings,
  env: {
    ...defaultSettings.env,
    APP_ENV: 'test',
  },
  logger: {
    ...defaultSettings.logger,
    level: 'error',
  },
  database: {
    ...defaultSettings.database,
    storage: path.join(os.tmpdir(), 'tego-test', testDbName),
  },
  presets: {
    ...defaultSettings.presets,
    runtimePlugins: [],
  },
};
TachybaseGlobal.getInstance().set('PLUGIN_PATHS', [path.resolve(process.cwd(), 'packages')]);

process.env.TEGO_RUNTIME_HOME = path.join(os.tmpdir(), 'test-sqlite');
process.env.APP_ENV_PATH = process.env.APP_ENV_PATH || '.env.test';

initEnv();

TachybaseGlobal.settings = {
  ...TachybaseGlobal.settings,
  env: {
    ...TachybaseGlobal.settings.env,
    APP_ENV: 'test',
  },
  logger: {
    ...TachybaseGlobal.settings.logger,
    level: 'error',
  },
  database: {
    ...TachybaseGlobal.settings.database,
    storage: path.join(os.tmpdir(), 'tego-test', testDbName),
  },
  presets: {
    ...TachybaseGlobal.settings.presets,
    runtimePlugins: [],
  },
};
TachybaseGlobal.getInstance().set('PLUGIN_PATHS', [path.resolve(process.cwd(), 'packages')]);

const workspacePackageNameByShortName = (name: string) => {
  const packageDirByPluginName: Record<string, string> = {
    'collection-manager': 'module-collection',
    'data-source-manager': 'module-data-source',
    users: 'module-user',
  };
  const candidates = [packageDirByPluginName[name], `module-${name}`, `plugin-${name}`].filter(Boolean);
  for (const packageDir of candidates) {
    const packageJsonPath = path.resolve(process.cwd(), 'packages', packageDir, 'package.json');
    if (require('node:fs').existsSync(packageJsonPath)) {
      const packageJson = require(packageJsonPath);
      return packageJson.name;
    }
  }
  return null;
};

const workspacePackageDirByPackageName = (packageName?: string) => {
  if (!packageName) {
    return null;
  }

  const packageDir = packageName.replace('@tachybase/', '');
  const packageJsonPath = path.resolve(process.cwd(), 'packages', packageDir, 'package.json');
  return require('node:fs').existsSync(packageJsonPath) ? packageDir : null;
};

const patchPluginRuntime = (core: any) => {
  const originalLoadCollections = core.Plugin.prototype.loadCollections;

  core.Plugin.prototype.loadCollections = async function loadWorkspaceCollections() {
    const packageDir = this.options?.workspaceSource
      ? workspacePackageDirByPackageName(this.options?.packageName)
      : null;
    if (!packageDir) {
      return originalLoadCollections.call(this);
    }

    const directory = path.resolve(process.cwd(), 'packages', packageDir, 'src/server/collections');
    if (!require('node:fs').existsSync(directory)) {
      return;
    }

    await this.db.import({
      directory,
      from: this.options.packageName,
    });
  };
};

const patchPluginManager = (PluginManager: any) => {
  const resolvePlugin = PluginManager.resolvePlugin.bind(PluginManager);
  const workspaceSourcePackages = new Set<string>();

  PluginManager.getPackageName = async (name: string) => workspacePackageNameByShortName(name) || name;
  PluginManager.getPackageJson = async (packageName: string) => {
    const packageDir = workspacePackageDirByPackageName(packageName);
    if (packageDir) {
      return require(path.resolve(process.cwd(), 'packages', packageDir, 'package.json'));
    }
    return require(serverRequire.resolve(path.join(packageName, 'package.json')));
  };
  PluginManager.resolvePlugin = async (pluginName: any, isUpgrade = false, isPkg = false) => {
    if (typeof pluginName !== 'string') {
      return pluginName;
    }

    const packageName = isPkg ? pluginName : await PluginManager.getPackageName(pluginName);
    const packageDir = workspaceSourcePackages.has(packageName) ? workspacePackageDirByPackageName(packageName) : null;
    if (!packageDir) {
      return resolvePlugin(pluginName, isUpgrade, isPkg);
    }

    const pluginModule = await import(
      pathToFileURL(path.resolve(process.cwd(), 'packages', packageDir, 'src/server/index.ts')).href
    );
    return pluginModule.default;
  };
  PluginManager.prototype.initRuntimePlugins = async function initNoRuntimePlugins() {
    this['_initRuntimePlugins'] = true;
  };
  PluginManager.prototype.initOtherPlugins = async function initNoOtherPlugins() {
    this['_initOtherPlugins'] = true;
  };
  PluginManager.prototype.initPresetPlugins = async function initWorkspacePresetPlugins() {
    if (this['_initPresetPlugins']) {
      return;
    }

    for (const plugin of this.options.plugins || []) {
      const [pluginName, options = {}] = Array.isArray(plugin) ? plugin : [plugin];
      const packageName = typeof pluginName === 'string' ? workspacePackageNameByShortName(pluginName) : null;
      if (packageName) {
        workspaceSourcePackages.add(packageName);
        await this.add(pluginName, { enabled: true, ...options, packageName, workspaceSource: true });
      } else if (typeof pluginName === 'function') {
        await this.add(pluginName, { enabled: true, ...options });
      } else {
        await this.add(pluginName, { enabled: true, isPreset: true, ...options });
      }
    }

    this['_initPresetPlugins'] = true;
  };
};

const testCore = testRequire('@tego/core');
const serverCore = serverRequire('@tego/core');
patchPluginRuntime(testCore);
patchPluginRuntime(serverCore);
patchPluginManager(testCore.PluginManager);
patchPluginManager(serverCore.PluginManager);
