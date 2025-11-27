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

  // 注册 hostname 修复函数到全局，供 WebSocketClient 调用
  // 这个函数符合 WebSocketClient 定义的 HostnameFixer 类型
  const fixHostname = (hostname: string): string => {
    // 仅在 Electron 环境（app: 协议）中执行修复
    if (window.location.protocol === 'app:') {
      // 修复无效的 hostname
      if (hostname === 'index.html' || hostname === 'admin' || !hostname) {
        console.log(`[Preload] WebSocketClient hostname fixed: ${hostname || '(empty)'} -> localhost`);
        return 'localhost';
      }
    }
    // 如果不需要修复，返回原值
    return hostname;
  };

  // 将修复函数注册到全局，供 WebSocketClient 的扩展机制调用
  (window as any).__tachybase_fix_websocket_hostname__ = fixHostname;
  console.log('[Preload] WebSocketClient hostname fix function registered');
}
