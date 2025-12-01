/**
 * Desktop 专用的 WebSocketClient hostname 修复
 *
 * 利用 WebSocketClient 提供的扩展机制，在 Electron 环境中修复 hostname
 * 这个修复函数会在 WebSocketClient.getURL() 生成 URL 时被调用
 */
export function setupWebSocketClientFix(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const globalWindow = globalThis as any;

  const fixHostname = (hostname: string): string => {
    if (window.location.protocol === 'app:') {
      const locationHostname = globalWindow.__tachybase_location_hostname__;

      if (
        locationHostname &&
        typeof locationHostname === 'string' &&
        locationHostname !== 'index.html' &&
        locationHostname !== 'admin'
      ) {
        return hostname !== locationHostname ? locationHostname : hostname;
      }

      if (hostname === 'index.html' || hostname === 'admin' || !hostname) {
        return 'localhost';
      }

      if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        return 'localhost';
      }
    }
    return hostname;
  };

  globalWindow.__tachybase_fix_websocket_hostname__ = fixHostname;
}
