import type { Plugin } from '@tachybase/client-core';

export type PluginState = 'loading' | 'loaded' | 'unloading' | 'unloaded' | 'error';

export interface PluginInfo {
  name: string;
  packageName?: string;
  version?: string;
  plugin: typeof Plugin;
  instance?: Plugin;
  state: PluginState;
  dependencies: string[];
  dependents: string[];
  error?: Error;
  loadTime?: number;
}

/**
 * 插件注册表
 * 管理插件的注册、状态跟踪和依赖关系
 */
export class PluginRegistry {
  private plugins: Map<string, PluginInfo> = new Map();
  private pluginInstances: Map<typeof Plugin, Plugin> = new Map();

  /**
   * 注册插件
   * @param name 插件名称
   * @param pluginClass 插件类
   * @param options 插件选项
   */
  register(
    name: string,
    pluginClass: typeof Plugin,
    options: {
      packageName?: string;
      version?: string;
      dependencies?: string[];
    } = {},
  ): void {
    if (this.plugins.has(name)) {
      console.warn(`[PluginRegistry] Plugin ${name} is already registered`);
      return;
    }

    const pluginInfo: PluginInfo = {
      name,
      packageName: options.packageName || name,
      version: options.version,
      plugin: pluginClass,
      state: 'unloaded',
      dependencies: options.dependencies || [],
      dependents: [],
    };

    this.plugins.set(name, pluginInfo);

    // 更新依赖关系
    this.updateDependencies(name, pluginInfo.dependencies);
  }

  /**
   * 更新依赖关系
   * @param pluginName 插件名称
   * @param dependencies 依赖列表
   */
  private updateDependencies(pluginName: string, dependencies: string[]): void {
    dependencies.forEach((depName) => {
      const depInfo = this.plugins.get(depName);
      if (depInfo) {
        if (!depInfo.dependents.includes(pluginName)) {
          depInfo.dependents.push(pluginName);
        }
      }
    });
  }

  /**
   * 获取插件信息
   * @param name 插件名称
   * @returns 插件信息或 undefined
   */
  get(name: string): PluginInfo | undefined {
    return this.plugins.get(name);
  }

  /**
   * 获取插件实例
   * @param name 插件名称
   * @returns 插件实例或 undefined
   */
  getInstance(name: string): Plugin | undefined {
    const info = this.plugins.get(name);
    return info?.instance;
  }

  /**
   * 设置插件实例
   * @param name 插件名称
   * @param instance 插件实例
   */
  setInstance(name: string, instance: Plugin): void {
    const info = this.plugins.get(name);
    if (info) {
      info.instance = instance;
      this.pluginInstances.set(info.plugin, instance);
    }
  }

  /**
   * 更新插件状态
   * @param name 插件名称
   * @param state 新状态
   * @param error 错误信息（可选）
   */
  setState(name: string, state: PluginState, error?: Error): void {
    const info = this.plugins.get(name);
    if (info) {
      info.state = state;
      if (error) {
        info.error = error;
      }
      if (state === 'loaded') {
        info.loadTime = Date.now();
      }
    }
  }

  /**
   * 获取所有已注册的插件名称
   * @returns 插件名称数组
   */
  getRegisteredPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * 获取所有已加载的插件名称
   * @returns 插件名称数组
   */
  getLoadedPlugins(): string[] {
    return Array.from(this.plugins.values())
      .filter((info) => info.state === 'loaded')
      .map((info) => info.name);
  }

  /**
   * 获取插件的依赖
   * @param name 插件名称
   * @returns 依赖插件名称数组
   */
  getDependencies(name: string): string[] {
    const info = this.plugins.get(name);
    return info?.dependencies || [];
  }

  /**
   * 获取依赖该插件的其他插件
   * @param name 插件名称
   * @returns 依赖该插件的插件名称数组
   */
  getDependents(name: string): string[] {
    const info = this.plugins.get(name);
    return info?.dependents || [];
  }

  /**
   * 检查插件是否可以卸载
   * @param name 插件名称
   * @returns 是否可以卸载
   */
  canUnload(name: string): boolean {
    const dependents = this.getDependents(name);
    const loadedDependents = dependents.filter((dep) => {
      const depInfo = this.plugins.get(dep);
      return depInfo?.state === 'loaded';
    });
    return loadedDependents.length === 0;
  }

  /**
   * 卸载插件（从注册表中移除）
   * @param name 插件名称
   */
  unregister(name: string): void {
    const info = this.plugins.get(name);
    if (info) {
      if (info.instance) {
        this.pluginInstances.delete(info.plugin);
      }
      this.plugins.delete(name);

      // 清理依赖关系
      this.plugins.forEach((pluginInfo) => {
        pluginInfo.dependents = pluginInfo.dependents.filter((dep) => dep !== name);
      });
    }
  }

  /**
   * 清除所有注册
   */
  clear(): void {
    this.plugins.clear();
    this.pluginInstances.clear();
  }
}
