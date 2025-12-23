/**
 * 热模块加载器
 * 支持动态加载、卸载和重载模块
 */
export class HotModuleLoader {
  private moduleCache: Map<string, any> = new Map();
  private moduleUrls: Map<string, string> = new Map();
  private moduleLoadCallbacks: Map<string, Set<(module: any) => void>> = new Map();

  /**
   * 加载模块
   * @param url 模块 URL
   * @param name 模块名称（可选，用于标识）
   * @returns 加载的模块
   */
  async loadModule(url: string, name?: string): Promise<any> {
    const key = name || url;

    // 如果已缓存，返回缓存的模块
    if (this.moduleCache.has(key)) {
      return this.moduleCache.get(key);
    }

    try {
      // 使用动态 import 加载模块
      // @ts-ignore - 动态 import 在运行时可用
      const module = await import(/* @vite-ignore */ url);
      this.moduleCache.set(key, module);
      this.moduleUrls.set(key, url);

      // 触发加载回调
      const callbacks = this.moduleLoadCallbacks.get(key);
      if (callbacks) {
        callbacks.forEach((callback) => callback(module));
      }

      return module;
    } catch (error) {
      console.error(`[HotModuleLoader] Failed to load module ${key} from ${url}:`, error);
      throw error;
    }
  }

  /**
   * 卸载模块
   * @param name 模块名称
   */
  async unloadModule(name: string): Promise<void> {
    if (!this.moduleCache.has(name)) {
      console.warn(`[HotModuleLoader] Module ${name} not found in cache`);
      return;
    }

    // 从缓存中移除
    this.moduleCache.delete(name);
    this.moduleUrls.delete(name);

    // 清理回调
    this.moduleLoadCallbacks.delete(name);

    // 触发 React 重新渲染（通过事件）
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('module:unloaded', { detail: { name } }));
    }
  }

  /**
   * 重载模块
   * @param name 模块名称
   * @returns 重新加载的模块
   */
  async reloadModule(name: string): Promise<any> {
    const url = this.moduleUrls.get(name);
    if (!url) {
      throw new Error(`[HotModuleLoader] Module ${name} not found. Cannot reload.`);
    }

    // 先卸载
    await this.unloadModule(name);

    // 重新加载
    return await this.loadModule(url, name);
  }

  /**
   * 获取已加载的模块
   * @param name 模块名称
   * @returns 模块或 undefined
   */
  getModule(name: string): any {
    return this.moduleCache.get(name);
  }

  /**
   * 检查模块是否已加载
   * @param name 模块名称
   * @returns 是否已加载
   */
  hasModule(name: string): boolean {
    return this.moduleCache.has(name);
  }

  /**
   * 注册模块加载回调
   * @param name 模块名称
   * @param callback 回调函数
   */
  onModuleLoad(name: string, callback: (module: any) => void): () => void {
    if (!this.moduleLoadCallbacks.has(name)) {
      this.moduleLoadCallbacks.set(name, new Set());
    }
    this.moduleLoadCallbacks.get(name)!.add(callback);

    // 如果模块已加载，立即调用回调
    const module = this.moduleCache.get(name);
    if (module) {
      callback(module);
    }

    // 返回取消注册函数
    return () => {
      const callbacks = this.moduleLoadCallbacks.get(name);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  /**
   * 清除所有模块缓存
   */
  clearCache(): void {
    this.moduleCache.clear();
    this.moduleUrls.clear();
    this.moduleLoadCallbacks.clear();
  }

  /**
   * 获取所有已加载的模块名称
   * @returns 模块名称数组
   */
  getLoadedModuleNames(): string[] {
    return Array.from(this.moduleCache.keys());
  }
}
