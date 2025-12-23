/**
 * 插件沙箱
 * 提供插件隔离机制（CSS 命名空间、错误边界、状态隔离）
 */
export class PluginSandbox {
  private cssNamespaces: Map<string, string> = new Map();
  private errorBoundaries: Map<string, any> = new Map();

  /**
   * 为插件创建 CSS 命名空间
   * @param pluginName 插件名称
   * @returns CSS 命名空间前缀
   */
  createCSSNamespace(pluginName: string): string {
    const namespace = `plugin-${pluginName}`;
    this.cssNamespaces.set(pluginName, namespace);
    return namespace;
  }

  /**
   * 获取插件的 CSS 命名空间
   * @param pluginName 插件名称
   * @returns CSS 命名空间前缀
   */
  getCSSNamespace(pluginName: string): string | undefined {
    return this.cssNamespaces.get(pluginName);
  }

  /**
   * 为插件创建错误边界
   * @param pluginName 插件名称
   * @param errorHandler 错误处理函数
   */
  createErrorBoundary(pluginName: string, errorHandler?: (error: Error, errorInfo: any) => void): void {
    this.errorBoundaries.set(pluginName, {
      errorHandler,
      hasError: false,
      error: null,
    });
  }

  /**
   * 报告插件错误
   * @param pluginName 插件名称
   * @param error 错误对象
   * @param errorInfo 错误信息
   */
  reportError(pluginName: string, error: Error, errorInfo?: any): void {
    const boundary = this.errorBoundaries.get(pluginName);
    if (boundary) {
      boundary.hasError = true;
      boundary.error = error;
      if (boundary.errorHandler) {
        boundary.errorHandler(error, errorInfo);
      } else {
        console.error(`[PluginSandbox] Error in plugin ${pluginName}:`, error, errorInfo);
      }
    }
  }

  /**
   * 清除插件错误
   * @param pluginName 插件名称
   */
  clearError(pluginName: string): void {
    const boundary = this.errorBoundaries.get(pluginName);
    if (boundary) {
      boundary.hasError = false;
      boundary.error = null;
    }
  }

  /**
   * 检查插件是否有错误
   * @param pluginName 插件名称
   * @returns 是否有错误
   */
  hasError(pluginName: string): boolean {
    const boundary = this.errorBoundaries.get(pluginName);
    return boundary?.hasError || false;
  }

  /**
   * 获取插件错误
   * @param pluginName 插件名称
   * @returns 错误对象或 null
   */
  getError(pluginName: string): Error | null {
    const boundary = this.errorBoundaries.get(pluginName);
    return boundary?.error || null;
  }

  /**
   * 清理插件沙箱
   * @param pluginName 插件名称
   */
  cleanup(pluginName: string): void {
    this.cssNamespaces.delete(pluginName);
    this.errorBoundaries.delete(pluginName);
  }

  /**
   * 清理所有沙箱
   */
  clear(): void {
    this.cssNamespaces.clear();
    this.errorBoundaries.clear();
  }
}
