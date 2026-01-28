import type { Plugin } from '@tachybase/client-core';

/**
 * 插件生命周期管理器
 * 负责管理插件的加载和卸载流程
 */
export class PluginLifecycle {
  /**
   * 加载插件
   * @param plugin 插件实例
   */
  async load(plugin: Plugin): Promise<void> {
    try {
      await plugin.beforeLoad();
      await plugin.load();
      await plugin.afterLoad();
    } catch (error) {
      console.error(`[PluginLifecycle] Error loading plugin:`, error);
      throw error;
    }
  }

  /**
   * 卸载插件
   * @param plugin 插件实例
   */
  async unload(plugin: Plugin): Promise<void> {
    try {
      // 执行卸载生命周期钩子
      if (typeof plugin.beforeUnload === 'function') {
        await plugin.beforeUnload();
      }
      if (typeof plugin.unload === 'function') {
        await plugin.unload();
      }
      if (typeof plugin.afterUnload === 'function') {
        await plugin.afterUnload();
      }

      // 清理插件资源
      this.cleanupPlugin(plugin);
    } catch (error) {
      console.error(`[PluginLifecycle] Error unloading plugin:`, error);
      throw error;
    }
  }

  /**
   * 清理插件资源
   * @param plugin 插件实例
   */
  private cleanupPlugin(plugin: Plugin): void {
    // 清理组件注册
    // 注意：这里不直接删除组件，由 Application 管理
    // 插件可以通过 unregisterComponent 方法自行清理

    // 清理路由
    // 路由清理由 RouterManager 处理

    // 清理事件监听器
    if (typeof (plugin as any).cleanupEventListeners === 'function') {
      (plugin as any).cleanupEventListeners();
    }
  }
}
