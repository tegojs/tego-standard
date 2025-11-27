/**
 * Desktop 专用的 WebSocketClient hostname 修复
 *
 * 利用 WebSocketClient 提供的扩展机制，在 Electron 环境中修复 hostname
 * 这个修复函数会在 WebSocketClient.getURL() 生成 URL 时被调用
 *
 * 扩展机制说明：
 * WebSocketClient 在 getURL() 方法中会检查 window.__tachybase_fix_websocket_hostname__
 * 如果存在且为函数，则调用它来修复 hostname。这使得特定环境（如 Electron）
 * 可以在不修改通用代码的情况下，提供自定义的 hostname 修复逻辑。
 */

/**
 * 设置 WebSocketClient hostname 修复函数
 *
 * 这个函数利用 WebSocketClient 提供的扩展机制，在 Electron 环境中
 * 自动将无效的 hostname（如 index.html、admin）修复为 localhost
 */
export function setupWebSocketClientFix(): void {
  if (typeof window === 'undefined') {
    return;
  }

  // 确保在 globalThis 和 window 上都注册，以兼容不同的访问方式
  const globalWindow = globalThis as any;
  const targetWindow = window as any;

  // 注册 hostname 修复函数到全局，供 WebSocketClient 调用
  // 这个函数符合 WebSocketClient 定义的 HostnameFixer 类型
  const fixHostname = (hostname: string): string => {
    // 仅在 Electron 环境（app: 协议）中执行修复
    if (window.location.protocol === 'app:') {
      // 优先使用 __tachybase_location_hostname__（应该已经设置为 localhost）
      // 同时检查 globalThis 和 window，确保能找到它
      const locationHostname =
        (globalWindow as any).__tachybase_location_hostname__ ||
        (targetWindow as any).__tachybase_location_hostname__ ||
        (window as any).__tachybase_location_hostname__;

      // 调试日志：记录函数被调用的情况
      console.log(
        `[Preload] WebSocketClient hostname fixer called with hostname: ${hostname}, __tachybase_location_hostname__: ${locationHostname}`,
      );

      // 如果 __tachybase_location_hostname__ 已正确设置（非空且不是无效值），始终使用它
      // 在 Electron 环境中，这是唯一正确的 hostname 值
      if (
        locationHostname &&
        typeof locationHostname === 'string' &&
        locationHostname !== 'index.html' &&
        locationHostname !== 'admin'
      ) {
        // 在 Electron 环境中，无论传入什么 hostname，都应该使用 locationHostname
        // 这样可以确保即使 window.location.hostname 是 index.html，也能生成正确的 URL
        if (hostname !== locationHostname) {
          console.log(
            `[Preload] WebSocketClient hostname fixed using __tachybase_location_hostname__: ${hostname || '(empty)'} -> ${locationHostname}`,
          );
          return locationHostname;
        }
        // 如果 hostname 已经是正确的，直接返回
        console.log(`[Preload] WebSocketClient hostname already correct: ${hostname}`);
        return hostname;
      }

      // 如果 __tachybase_location_hostname__ 未设置或无效，修复无效的 hostname 为 localhost
      // 在 Electron 环境中，index.html、admin 或空值都是无效的 hostname，应该修复为 localhost
      if (hostname === 'index.html' || hostname === 'admin' || !hostname) {
        console.log(`[Preload] WebSocketClient hostname fixed (fallback): ${hostname || '(empty)'} -> localhost`);
        return 'localhost';
      }

      // 如果 hostname 不是无效值，但也不是 localhost，在 Electron 环境中也应该使用 localhost
      // 这样可以确保所有 WebSocket 连接都使用 localhost
      if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        console.log(
          `[Preload] WebSocketClient hostname fixed to localhost (Electron environment): ${hostname} -> localhost`,
        );
        return 'localhost';
      }

      console.log(`[Preload] WebSocketClient hostname already correct: ${hostname}`);
    }
    // 如果不需要修复，返回原值
    return hostname;
  };

  // 将修复函数注册到全局（globalThis 和 window），供 WebSocketClient 的扩展机制调用
  // 确保在两种访问方式下都能找到扩展函数
  // 使用直接赋值，确保属性可被找到
  // 同时注册到多个可能的位置，确保能被找到
  globalWindow.__tachybase_fix_websocket_hostname__ = fixHostname;
  targetWindow.__tachybase_fix_websocket_hostname__ = fixHostname;

  // 如果 globalThis 和 window 不是同一个对象，也注册到 window 上
  if (globalWindow !== targetWindow) {
    try {
      const windowObj = (globalWindow as any).window;
      if (windowObj) {
        windowObj.__tachybase_fix_websocket_hostname__ = fixHostname;
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // 同时使用 Object.defineProperty 设置一个不可覆盖的版本（如果可能）
  try {
    Object.defineProperty(globalWindow, '__tachybase_fix_websocket_hostname__', {
      value: fixHostname,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    // 忽略错误，直接赋值已经完成
  }

  try {
    Object.defineProperty(targetWindow, '__tachybase_fix_websocket_hostname__', {
      value: fixHostname,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    // 忽略错误，直接赋值已经完成
  }

  // 验证注册是否成功
  const isRegisteredOnGlobal = typeof globalWindow.__tachybase_fix_websocket_hostname__ === 'function';
  const isRegisteredOnWindow = typeof targetWindow.__tachybase_fix_websocket_hostname__ === 'function';
  const isRegistered = isRegisteredOnGlobal && isRegisteredOnWindow;

  // 立即测试扩展函数是否可以被访问
  const testAccess = () => {
    const testWindow = window as any;
    const testGlobal = globalThis as any;
    const fromWindow = testWindow.__tachybase_fix_websocket_hostname__;
    const fromGlobal = testGlobal.__tachybase_fix_websocket_hostname__;

    console.log('[Preload] WebSocketClient hostname fix function access test', {
      fromWindow: typeof fromWindow === 'function',
      fromGlobal: typeof fromGlobal === 'function',
      windowEqualsGlobal: testWindow === testGlobal,
      windowLocationHostname: testWindow.location?.hostname,
      __tachybase_location_hostname__:
        testWindow.__tachybase_location_hostname__ || testGlobal.__tachybase_location_hostname__,
    });
  };

  // 立即测试
  testAccess();

  // 延迟测试，确保在页面加载后也能访问
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('DOMContentLoaded', testAccess);
    window.addEventListener('load', testAccess);
  }

  console.log('[Preload] WebSocketClient hostname fix function registered', {
    onGlobalThis: isRegisteredOnGlobal,
    onWindow: isRegisteredOnWindow,
    isRegistered,
    globalThisEqualsWindow: globalWindow === targetWindow,
  });

  // 添加一个定期检查，确保扩展函数始终可用
  // 这可以防止在某些情况下扩展函数被覆盖或丢失
  if (typeof setInterval !== 'undefined') {
    const checkInterval = setInterval(() => {
      const currentOnGlobal = typeof (globalThis as any).__tachybase_fix_websocket_hostname__ === 'function';
      const currentOnWindow = typeof (window as any).__tachybase_fix_websocket_hostname__ === 'function';

      if (!currentOnGlobal || !currentOnWindow) {
        console.warn('[Preload] WebSocketClient hostname fix function lost, re-registering...', {
          onGlobalThis: currentOnGlobal,
          onWindow: currentOnWindow,
        });

        // 重新注册
        try {
          (globalThis as any).__tachybase_fix_websocket_hostname__ = fixHostname;
          (window as any).__tachybase_fix_websocket_hostname__ = fixHostname;
        } catch (e) {
          console.error('[Preload] Failed to re-register hostname fix function:', e);
        }
      }
    }, 1000);

    // 在页面卸载时清理
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', () => {
        clearInterval(checkInterval);
      });
    }
  }
}
