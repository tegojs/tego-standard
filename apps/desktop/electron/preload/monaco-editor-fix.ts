/**
 * Monaco Editor 修复脚本
 * 在 Electron 环境中配置 Monaco Editor 使用本地资源
 * 如果本地资源不可用，将由组件层面的降级机制处理
 */
export function setupMonacoEditorFix() {
  // 检测是否在 electron 环境中（app:// 协议）
  if (typeof window === 'undefined' || window.location.protocol !== 'app:') {
    return;
  }

  // 在页面加载后配置 Monaco Editor
  const configureMonacoLoader = async () => {
    try {
      // 动态导入 @monaco-editor/react 的 loader
      const monacoModule = await import('@monaco-editor/react');
      const { loader } = monacoModule;

      if (!loader || typeof loader.config !== 'function') {
        console.warn('[Electron] Monaco Editor loader not available');
        return;
      }

      // 直接配置使用本地资源路径
      const localPath = '/assets/monaco-editor/vs';

      loader.config({
        paths: {
          vs: localPath,
        },
      });

      console.log('[Electron] Configured Monaco Editor to use local resources:', localPath);
    } catch (error) {
      console.warn('[Electron] Failed to configure Monaco Editor loader:', error);
      // 配置失败不影响功能，会使用默认配置或由组件层面的降级机制处理
    }
  };

  // 延迟执行，确保在 @tego/client 的配置之后
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', configureMonacoLoader);
  } else {
    // 使用 setTimeout 确保在 @tego/client 的配置之后执行
    setTimeout(configureMonacoLoader, 100);
  }
}
