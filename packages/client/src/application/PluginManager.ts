import type { Application } from './Application';
import { Plugin } from './Plugin';
import { getPlugins } from './utils/remotePlugins';

export type PluginOptions<T = any> = { name?: string; packageName?: string; config?: T };
export type PluginType<Opts = any> = typeof Plugin | [typeof Plugin, PluginOptions<Opts>];
export type PluginData = {
  name: string;
  packageName: string;
  version: string;
  url: string;
  type: 'local' | 'upload' | 'npm';
};

export class PluginManager {
  protected pluginInstances: Map<typeof Plugin, Plugin> = new Map();
  protected pluginsAliases: Record<string, Plugin> = {};
  private initPlugins: Promise<void>;

  constructor(
    protected _plugins: PluginType[],
    protected loadRemotePlugins: boolean,
    protected app: Application,
  ) {
    this.app = app;
    this.initPlugins = this.init(_plugins);
  }

  /**
   * @internal
   */
  async init(_plugins: PluginType[]) {
    await this.initStaticPlugins(_plugins);
    if (this.loadRemotePlugins) {
      await this.initRemotePlugins();
    }
  }

  private async initStaticPlugins(_plugins: PluginType[] = []) {
    for await (const plugin of _plugins) {
      const pluginClass = Array.isArray(plugin) ? plugin[0] : plugin;
      const opts = Array.isArray(plugin) ? plugin[1] : undefined;
      await this.add(pluginClass, opts);
    }
  }

  private async initRemotePlugins() {
    const res = await this.app.apiClient.request({ url: 'pm:listEnabled' });

    // 详细日志:API 响应结构
    console.log('[PluginManager.initRemotePlugins] Raw API response:', {
      hasRes: !!res,
      resType: typeof res,
      resKeys: res ? Object.keys(res).slice(0, 10) : [],
      hasData: !!res?.data,
      dataType: typeof res?.data,
      dataKeys: res?.data ? Object.keys(res.data).slice(0, 10) : [],
      dataIsArray: Array.isArray(res?.data),
      hasDataData: !!res?.data?.data,
      dataDataType: typeof res?.data?.data,
      dataDataIsArray: Array.isArray(res?.data?.data),
      dataDataConstructor: res?.data?.data?.constructor?.name,
      dataDataKeys:
        res?.data?.data && typeof res?.data?.data === 'object' ? Object.keys(res.data.data).slice(0, 10) : [],
    });

    // 修复:处理嵌套的 {data: {data: [...]}} 结构
    let pluginList: PluginData[] = [];
    if (Array.isArray(res?.data?.data)) {
      // 标准结构: {data: {data: [...]}}
      pluginList = res.data.data;
      console.log('[PluginManager.initRemotePlugins] ✓ Used standard structure: res.data.data (array)');
    } else if (res?.data?.data && typeof res.data.data === 'object' && Array.isArray((res.data.data as any).data)) {
      // 嵌套结构: {data: {data: {data: [...]}}}
      pluginList = (res.data.data as any).data;
      console.log('[PluginManager.initRemotePlugins] ✓ Extracted nested .data property: res.data.data.data (array)');
    } else if (Array.isArray(res?.data)) {
      // 简化结构: {data: [...]}
      pluginList = res.data;
      console.log('[PluginManager.initRemotePlugins] ✓ Used simplified structure: res.data (array)');
    } else {
      console.error('[PluginManager.initRemotePlugins] ✗ Failed to extract array from API response!');
    }

    // 详细日志:提取的 pluginList
    console.log('[PluginManager.initRemotePlugins] Extracted pluginList:', {
      pluginListType: typeof pluginList,
      pluginListIsArray: Array.isArray(pluginList),
      pluginListConstructor: pluginList?.constructor?.name,
      pluginListLength: Array.isArray(pluginList) ? pluginList.length : 'N/A',
      pluginListKeys:
        typeof pluginList === 'object' && !Array.isArray(pluginList) ? Object.keys(pluginList).slice(0, 10) : [],
      firstItem: Array.isArray(pluginList) && pluginList.length > 0 ? pluginList[0] : null,
      hasFindMethod: typeof pluginList?.find === 'function',
    });

    const plugins = await getPlugins({
      requirejs: this.app.requirejs,
      pluginData: pluginList,
      devDynamicImport: this.app.devDynamicImport,
    });

    // 详细日志:getPlugins 返回结果
    console.log('[PluginManager.initRemotePlugins] getPlugins returned:', {
      pluginsType: typeof plugins,
      pluginsIsArray: Array.isArray(plugins),
      pluginsLength: Array.isArray(plugins) ? plugins.length : 'N/A',
      pluginsConstructor: plugins?.constructor?.name,
      firstPlugin: Array.isArray(plugins) && plugins.length > 0 ? plugins[0] : null,
    });

    let processedCount = 0;
    for (const [name, pluginClass] of plugins) {
      processedCount++;
      console.log(`[PluginManager.initRemotePlugins] Processing plugin ${processedCount}/${plugins.length}:`, {
        name,
        pluginClassType: typeof pluginClass,
        aboutToCallFind: true,
        pluginListType: typeof pluginList,
        pluginListIsArray: Array.isArray(pluginList),
      });

      const info = pluginList.find((item) => item.name === name);
      await this.add(pluginClass, info);
    }

    console.log(`[PluginManager.initRemotePlugins] ✓ Successfully processed all ${processedCount} plugins`);
  }

  async add<T = any>(plugin: typeof Plugin, opts: PluginOptions<T> = {}) {
    const instance = this.getInstance(plugin, opts);

    this.pluginInstances.set(plugin, instance);

    if (opts.name) {
      this.pluginsAliases[opts.name] = instance;
    }

    if (opts.packageName) {
      this.pluginsAliases[opts.packageName] = instance;
    }

    await instance.afterAdd();
  }

  get<T extends typeof Plugin>(PluginClass: T): InstanceType<T>;
  get<T extends {}>(name: string): T;
  get(nameOrPluginClass: any) {
    if (typeof nameOrPluginClass === 'string') {
      return this.pluginsAliases[nameOrPluginClass];
    }
    return this.pluginInstances.get(nameOrPluginClass.default || nameOrPluginClass);
  }

  private getInstance<T>(plugin: typeof Plugin, opts?: T) {
    try {
      return new plugin(opts, this.app);
    } catch {
      return new Plugin({}, this.app);
    }
  }

  /**
   * @internal
   */
  async load() {
    await this.initPlugins;

    for (const plugin of this.pluginInstances.values()) {
      await plugin.beforeLoad();
    }

    for (const plugin of this.pluginInstances.values()) {
      await plugin.load();
    }

    for (const plugin of this.pluginInstances.values()) {
      await plugin.afterLoad();
    }
  }
}
