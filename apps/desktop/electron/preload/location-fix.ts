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
        const invalidHostnames = ['index.html', 'admin'];
        if (
          isDesktop &&
          (invalidHostnames.includes(originalHostname) ||
            !originalHostname ||
            originalHostname === '' ||
            originalHostname !== 'localhost')
        ) {
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

            console.log('[Preload] Set __tachybase_location_hostname__ to localhost');
            console.log('[Preload] Set __tachybase_location_origin__ to http://localhost:' + appPort);
          } catch (e) {
            console.warn('[Preload] Could not set location helper properties:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[Preload] Error checking location:', e);
    }
  }
}
