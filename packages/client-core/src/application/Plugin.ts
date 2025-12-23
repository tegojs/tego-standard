import type { ComponentType } from 'react';

import { ParseKeys, TOptions } from 'i18next';

import type { Application } from './Application';

export class Plugin<T = any> {
  // 资源追踪
  protected registeredComponents: Set<string> = new Set();
  protected registeredRoutes: Set<string> = new Set();
  protected registeredEventListeners: Array<{ target: any; event: string; handler: any }> = [];

  constructor(
    protected options: T,
    protected app: Application,
  ) {
    this.options = options;
    this.app = app;
  }

  get pluginManager() {
    return this.app.pluginManager;
  }

  get pm() {
    return this.app.pm;
  }

  get router() {
    return this.app.router;
  }

  get systemSettingsManager() {
    return this.app.systemSettingsManager;
  }

  get userSettingsManager() {
    return this.app.userSettingsManager;
  }

  get schemaInitializerManager() {
    return this.app.schemaInitializerManager;
  }

  get schemaSettingsManager() {
    return this.app.schemaSettingsManager;
  }

  get dataSourceManager() {
    return this.app.dataSourceManager;
  }

  get AttachmentPreviewManager() {
    return this.app.AttachmentPreviewManager;
  }

  async afterAdd() {}

  async beforeLoad() {}

  async load() {}

  async afterLoad() {}

  // 新增卸载生命周期
  async beforeUnload(): Promise<void> {}

  async unload(): Promise<void> {}

  async afterUnload(): Promise<void> {}

  // 资源清理辅助方法
  registerComponent(name: string, component: ComponentType): void {
    this.registeredComponents.add(name);
    this.app.addComponents({ [name]: component });
  }

  unregisterComponent(name: string): void {
    this.registeredComponents.delete(name);
    // 注意：这里不直接删除组件，由 Application 管理
  }

  registerRoute(name: string, route: any): void {
    this.registeredRoutes.add(name);
    this.app.router.add(name, route);
  }

  unregisterRoute(name: string): void {
    this.registeredRoutes.delete(name);
    // 路由清理由 RouterManager 处理
  }

  protected addEventListener(target: any, event: string, handler: any): void {
    this.registeredEventListeners.push({ target, event, handler });
    if (target.addEventListener) {
      target.addEventListener(event, handler);
    } else if (target.on) {
      target.on(event, handler);
    }
  }

  protected cleanupEventListeners(): void {
    this.registeredEventListeners.forEach(({ target, event, handler }) => {
      if (target.removeEventListener) {
        target.removeEventListener(event, handler);
      } else if (target.off) {
        target.off(event, handler);
      }
    });
    this.registeredEventListeners = [];
  }

  t(text: ParseKeys | ParseKeys[], options: TOptions = {}) {
    return this.app.i18n.t(text, { ns: this.options?.['packageName'], ...(options as any) }) as string;
  }
}
