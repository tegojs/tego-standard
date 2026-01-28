import { PluginLifecycle, PluginRegistry } from '@tachybase/client-plugins';

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
  private pluginLifecycle: PluginLifecycle;
  private pluginRegistry: PluginRegistry;

  constructor(
    protected _plugins: PluginType[],
    protected loadRemotePlugins: boolean,
    protected app: Application,
  ) {
    this.app = app;
    this.pluginLifecycle = new PluginLifecycle();
    this.pluginRegistry = new PluginRegistry();
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
    const pluginList: PluginData[] = res?.data?.data || [];
    const plugins = await getPlugins({
      requirejs: this.app.requirejs,
      pluginData: pluginList,
      devDynamicImport: this.app.devDynamicImport,
    });
    for await (const [name, pluginClass] of plugins) {
      try {
        const info = pluginList.find((item) => item.name === name);
        await this.add(pluginClass, info);
      } catch (error) {
        console.error(`[PluginManager.initRemotePlugins] ✗ Error adding plugin ${name}:`, {
          error,
          errorMessage: error?.message,
          errorStack: error?.stack,
          pluginClass,
        });
        throw error; // 重新抛出错误以保持原有行为
      }
    }
  }

  async add<T = any>(plugin: typeof Plugin, opts: PluginOptions<T> = {}) {
    const instance = this.getInstance(plugin, opts);

    this.pluginInstances.set(plugin, instance);

    const pluginName = opts.name || opts.packageName || plugin.name || 'unknown';

    if (opts.name) {
      this.pluginsAliases[opts.name] = instance;
    }

    if (opts.packageName) {
      this.pluginsAliases[opts.packageName] = instance;
    }

    // 注册到注册表
    this.pluginRegistry.register(pluginName, plugin, {
      packageName: opts.packageName,
      version: (opts as any).version,
      dependencies: (opts as any).dependencies || [],
    });
    this.pluginRegistry.setInstance(pluginName, instance);

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

    // 更新注册表状态
    for (const plugin of this.pluginInstances.values()) {
      const pluginName = this.getPluginName(plugin);
      if (pluginName) {
        this.pluginRegistry.setState(pluginName, 'loaded');
      }
    }
  }

  /**
   * 卸载插件
   * @param name 插件名称
   */
  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    // 检查是否可以卸载
    if (!this.pluginRegistry.canUnload(name)) {
      const dependents = this.pluginRegistry.getDependents(name);
      throw new Error(`Cannot unload plugin ${name}. It is required by: ${dependents.join(', ')}`);
    }

    // 更新状态
    this.pluginRegistry.setState(name, 'unloading');

    try {
      // 使用生命周期管理器卸载
      await this.pluginLifecycle.unload(plugin);

      // 从注册表中移除
      const pluginClass = this.getPluginClass(plugin);
      if (pluginClass) {
        this.pluginInstances.delete(pluginClass);
      }

      // 清理别名
      delete this.pluginsAliases[name];
      const pluginInfo = this.pluginRegistry.get(name);
      if (pluginInfo?.packageName && pluginInfo.packageName !== name) {
        delete this.pluginsAliases[pluginInfo.packageName];
      }

      // 更新注册表状态
      this.pluginRegistry.setState(name, 'unloaded');
    } catch (error) {
      this.pluginRegistry.setState(name, 'error', error as Error);
      throw error;
    }
  }

  /**
   * 重载插件
   * @param name 插件名称
   */
  async reloadPlugin(name: string): Promise<void> {
    const pluginInfo = this.pluginRegistry.get(name);
    if (!pluginInfo) {
      throw new Error(`Plugin ${name} not found in registry`);
    }

    // 先卸载
    await this.unloadPlugin(name);

    // 重新添加和加载
    try {
      await this.add(pluginInfo.plugin, {
        name: pluginInfo.name,
        packageName: pluginInfo.packageName,
        config: (pluginInfo.instance as any)?.options,
      });

      const instance = this.get(name);
      if (instance) {
        await this.pluginLifecycle.load(instance);
        this.pluginRegistry.setState(name, 'loaded');
      }
    } catch (error) {
      this.pluginRegistry.setState(name, 'error', error as Error);
      throw error;
    }
  }

  /**
   * 获取插件状态
   * @param name 插件名称
   * @returns 插件状态
   */
  getPluginState(name: string) {
    const info = this.pluginRegistry.get(name);
    return info?.state || 'unloaded';
  }

  /**
   * 获取所有已加载的插件名称
   * @returns 插件名称数组
   */
  getLoadedPlugins(): string[] {
    return this.pluginRegistry.getLoadedPlugins();
  }

  /**
   * 获取插件注册表
   * @returns 插件注册表实例
   */
  getRegistry(): PluginRegistry {
    return this.pluginRegistry;
  }

  /**
   * 获取插件名称（辅助方法）
   */
  private getPluginName(plugin: Plugin): string | null {
    for (const [name, instance] of Object.entries(this.pluginsAliases)) {
      if (instance === plugin) {
        return name;
      }
    }
    return null;
  }

  /**
   * 获取插件类（辅助方法）
   */
  private getPluginClass(plugin: Plugin): typeof Plugin | null {
    for (const [pluginClass, instance] of this.pluginInstances.entries()) {
      if (instance === plugin) {
        return pluginClass;
      }
    }
    return null;
  }
}
