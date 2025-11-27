import type { RequireJS } from '@tego/client';

import type { DevDynamicImport } from '../Application';
import type { Plugin } from '../Plugin';
import type { PluginData } from '../PluginManager';

/**
 * @internal
 */
export function defineDevPlugins(plugins: Record<string, unknown>) {
  Object.entries(plugins).forEach(([packageName, plugin]) => {
    // compatible with old hera module
    if (packageName === '@tachybase/module-hera') {
      window.define(`@hera/plugin-core/client`, () => plugin);
    }
    window.define(`${packageName}/client`, () => plugin);
  });
}

/**
 * @internal
 */
export function definePluginClient(packageName: string) {
  // compatible with old hera module
  if (packageName === '@tachybase/module-hera') {
    window.define(
      `@hera/plugin-core/client`,
      ['exports', `@hera/plugin-core/client`],
      function (_exports: any, _pluginExports: any) {
        Object.defineProperty(_exports, '__esModule', {
          value: true,
        });
        Object.keys(_pluginExports).forEach(function (key) {
          if (key === '__esModule') return;
          if (key in _exports && _exports[key] === _pluginExports[key]) return;
          Object.defineProperty(_exports, key, {
            enumerable: true,
            get: function () {
              return _pluginExports[key];
            },
          });
        });
      },
    );
  }
  window.define(`${packageName}/client`, ['exports', packageName], function (_exports: any, _pluginExports: any) {
    Object.defineProperty(_exports, '__esModule', {
      value: true,
    });
    Object.keys(_pluginExports).forEach(function (key) {
      if (key === '__esModule') return;
      if (key in _exports && _exports[key] === _pluginExports[key]) return;
      Object.defineProperty(_exports, key, {
        enumerable: true,
        get: function () {
          return _pluginExports[key];
        },
      });
    });
  });
}

/**
 * @internal
 */
export function configRequirejs(requirejs: any, pluginData: PluginData[]) {
  requirejs.requirejs.config({
    waitSeconds: 120,
    paths: pluginData.reduce<Record<string, string>>((acc, cur) => {
      acc[cur.packageName] = cur.url;
      return acc;
    }, {}),
  });
}

/**
 * @internal
 */
export function processRemotePlugins(pluginData: PluginData[], resolve: (plugins: [string, typeof Plugin][]) => void) {
  return (...pluginModules: (typeof Plugin & { default?: typeof Plugin })[]) => {
    console.log('[processRemotePlugins] Requirejs callback invoked:', {
      pluginModulesCount: pluginModules.length,
      pluginDataCount: pluginData.length,
      pluginModulesType: typeof pluginModules,
      pluginModulesIsArray: Array.isArray(pluginModules),
    });

    const res: [string, typeof Plugin][] = pluginModules
      .map<[string, typeof Plugin]>((item, index) => {
        const hasDefault = !!(item as any)?.default;
        console.log(
          `[processRemotePlugins] ${index + 1}/${pluginModules.length}: ${pluginData[index]?.packageName} - ${hasDefault ? '✓' : '○'} ${hasDefault ? 'has default' : 'no default'}`,
        );
        return [pluginData[index].name, item?.default || item];
      })
      .filter((item) => item[1]);

    console.log(`[processRemotePlugins] ✓ Processed ${res.length}/${pluginModules.length} modules successfully`);

    resolve(res);

    const emptyPlugins = pluginModules
      .map((item, index) => (!item ? index : null))
      .filter((i) => i !== null)
      .map((i) => pluginData[i].packageName);

    if (emptyPlugins.length > 0) {
      console.error(
        '[tachybase load plugin error]: These plugins do not have an `export.default` exported content or there is an error in the plugins. error plugins: \r\n%s',
        emptyPlugins.join(', \r\n'),
      );
    }
  };
}

/**
 * @internal
 */
export function getRemotePlugins(
  requirejs: any,
  pluginData: PluginData[] = [],
): Promise<Array<[string, typeof Plugin]>> {
  console.log('[getRemotePlugins] Called with:', {
    pluginDataCount: pluginData.length,
    pluginDataIsArray: Array.isArray(pluginData),
    packageNames: pluginData.slice(0, 5).map((p) => p.packageName),
  });

  configRequirejs(requirejs, pluginData);

  const packageNames = pluginData.map((item) => item.packageName);
  packageNames.forEach((packageName) => {
    definePluginClient(packageName);
  });

  console.log('[getRemotePlugins] Calling requirejs with packageNames:', packageNames.length);

  return new Promise((resolve, reject) => {
    requirejs.requirejs(packageNames, processRemotePlugins(pluginData, resolve), (error) => {
      console.error('[getRemotePlugins] requirejs error:', error);
      reject(error);
    });
  });
}

interface GetPluginsOption {
  requirejs: RequireJS;
  pluginData: PluginData[];
  devDynamicImport?: DevDynamicImport;
}

/**
 * @internal
 */
export async function getPlugins(options: GetPluginsOption): Promise<Array<[string, typeof Plugin]>> {
  // 详细日志:输入参数
  console.log('[getPlugins] Called with options:', {
    hasRequirejs: !!options.requirejs,
    hasDevDynamicImport: !!options.devDynamicImport,
    pluginDataType: typeof options.pluginData,
    pluginDataIsArray: Array.isArray(options.pluginData),
    pluginDataConstructor: options.pluginData?.constructor?.name,
    pluginDataLength: Array.isArray(options.pluginData) ? options.pluginData.length : 'N/A',
    pluginDataKeys:
      typeof options.pluginData === 'object' && !Array.isArray(options.pluginData)
        ? Object.keys(options.pluginData).slice(0, 10)
        : [],
  });

  const { requirejs, pluginData, devDynamicImport } = options;

  // 详细日志:检查 pluginData.length
  console.log('[getPlugins] Checking pluginData.length:', {
    hasLengthProperty: 'length' in pluginData,
    lengthValue: pluginData.length,
    lengthType: typeof pluginData.length,
  });

  if (pluginData.length === 0) {
    console.log('[getPlugins] ⚠ Early return: pluginData.length === 0');
    return [];
  }

  console.log(`[getPlugins] ✓ Starting to process ${pluginData.length} plugins`);

  const res: Array<[string, typeof Plugin]> = [];

  const resolveDevPlugins: Record<string, unknown> = {};
  if (devDynamicImport) {
    console.log('[getPlugins] Processing dev plugins in development mode...');
    let devPluginCount = 0;
    for await (const plugin of pluginData) {
      devPluginCount++;
      console.log(`[getPlugins] Dev plugin ${devPluginCount}/${pluginData.length}:`, {
        packageName: plugin?.packageName,
        name: plugin?.name,
      });

      const pluginModule = await devDynamicImport(plugin.packageName);
      if (pluginModule) {
        console.log(`[getPlugins] ✓ Dev plugin loaded:`, plugin.packageName);
        res.push([plugin.name, pluginModule.default]);
        resolveDevPlugins[plugin.packageName] = pluginModule;
      } else {
        console.log(`[getPlugins] ○ Dev plugin returned null (will load remotely):`, plugin.packageName);
      }
    }
    console.log(
      `[getPlugins] Dev plugins processed: ${Object.keys(resolveDevPlugins).length} loaded, ${pluginData.length - Object.keys(resolveDevPlugins).length} to load remotely`,
    );
    defineDevPlugins(resolveDevPlugins);
  }

  const remotePlugins = pluginData.filter((item) => !resolveDevPlugins[item.packageName]);

  console.log('[getPlugins] Remote plugins to load:', {
    count: remotePlugins.length,
    devPluginsCount: Object.keys(resolveDevPlugins).length,
  });

  if (remotePlugins.length === 0) {
    console.log(`[getPlugins] ✓ No remote plugins needed, returning ${res.length} dev plugins`);
    return res;
  }

  console.log(`[getPlugins] Loading ${remotePlugins.length} remote plugins via requirejs...`);
  const remotePluginList = await getRemotePlugins(requirejs, remotePlugins);

  console.log('[getPlugins] getRemotePlugins returned:', {
    type: typeof remotePluginList,
    isArray: Array.isArray(remotePluginList),
    length: Array.isArray(remotePluginList) ? remotePluginList.length : 'N/A',
  });

  res.push(...remotePluginList);

  console.log(
    `[getPlugins] ✓ Completed successfully: ${res.length} total plugins (${Object.keys(resolveDevPlugins).length} dev + ${remotePluginList.length} remote)`,
  );

  return res;
}
