import { getAppPort } from '../utils/config';

/**
 * 修复 window.location，避免生成错误的 WebSocket URL 和插件路径
 */
export function setupLocationFix(): void {
  const globalWindow = globalThis as any;

  if (typeof globalWindow !== 'undefined') {
    try {
      const location = globalWindow.location || (globalWindow.window && globalWindow.window.location);

      if (location) {
        const originalHostname = location.hostname;
        const isDesktop = location.protocol === 'app:';

        // 在 Electron 环境中，hostname 可能是 index.html、admin 或其他值，需要统一修复为 localhost
        // 确保总是设置 __tachybase_location_hostname__，以便 WebSocketClient 等通用代码可以使用
        if (isDesktop) {
          const invalidHostnames = ['index.html', 'admin'];
          const needsFix =
            invalidHostnames.includes(originalHostname) ||
            !originalHostname ||
            originalHostname === '' ||
            originalHostname !== 'localhost';

          // 如果 hostname 需要修复，或者 __tachybase_location_hostname__ 尚未设置，则设置它
          if (needsFix || !globalWindow.__tachybase_location_hostname__) {
            try {
              Object.defineProperty(globalWindow, '__tachybase_location_hostname__', {
                value: 'localhost',
                writable: false,
                configurable: false,
                enumerable: false,
              });

              const appPort = getAppPort();
              Object.defineProperty(globalWindow, '__tachybase_location_origin__', {
                value: `http://localhost:${appPort}`,
                writable: false,
                configurable: false,
                enumerable: false,
              });
            } catch (e) {
              console.warn('[Preload] Could not set location helper properties:', e);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Preload] Error checking location:', e);
    }
  }
}
