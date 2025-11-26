import { getAppPort } from '../utils/config';

/**
 * 拦截 WebSocket 构造函数，修复 WebSocket URL
 */
export function setupWebSocketInterceptor(): void {
  const globalObj = globalThis as any;
  const OriginalWebSocket = globalObj.WebSocket;
  const appPort = getAppPort();
  const wsBaseUrl = `ws://localhost:${appPort}`;

  if (!OriginalWebSocket) {
    return;
  }

  const InterceptedWebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      let wsUrl = typeof url === 'string' ? url : url.toString();
      const originalUrl = wsUrl;

      const isDesktop =
        typeof window !== 'undefined' &&
        (window.location.protocol === 'app:' || window.location.hostname === 'index.html');

      // 检查是否需要重定向（包括 ws://index.html:port 格式）
      const needsFullRedirect =
        wsUrl.startsWith('app://') ||
        wsUrl.startsWith('ws://index.html') ||
        wsUrl.startsWith('wss://index.html') ||
        wsUrl.startsWith('http://index.html') ||
        wsUrl.includes('index.html:');

      if (needsFullRedirect) {
        let path = '/ws';
        let query = '';

        // 提取路径和查询参数
        const pathMatch = wsUrl.match(/(\/ws[^?]*)(\?.*)?/);
        if (pathMatch) {
          path = pathMatch[1];
          query = pathMatch[2] || '';
        } else {
          const generalPathMatch = wsUrl.match(/\/([^?]+)(\?.*)?/);
          if (generalPathMatch) {
            path = `/${generalPathMatch[1]}`;
            query = generalPathMatch[2] || '';
          }
        }

        // 修复查询参数中的 hostname
        if (query) {
          query = query
            .replace(/__hostname=index\.html/g, '__hostname=localhost')
            .replace(/hostname=index\.html/g, 'hostname=localhost');
        }

        wsUrl = `${wsBaseUrl}${path}${query}`;
        console.log(`[Preload] WebSocket URL redirected: ${originalUrl} -> ${wsUrl}`);
      } else if (isDesktop) {
        // 处理其他需要修复的 WebSocket URL
        wsUrl = wsUrl
          .replace(/^(ws|wss):\/\/index\.html(:\d+)?/, (match, protocol, port) => {
            return `${protocol}://localhost${port || `:${appPort}`}`;
          })
          .replace(/^(ws|wss):\/\/index\.html:(\d+)/, (match, protocol, port) => {
            return `${protocol}://localhost:${port}`;
          })
          .replace(/^(ws|wss):\/\/([^/:]+)(:\d+)/, (match, protocol, hostname, port) => {
            if (hostname === 'index.html' || (typeof window !== 'undefined' && hostname === window.location.hostname)) {
              return `${protocol}://localhost${port}`;
            }
            return match;
          });

        // 修复查询参数中的 hostname
        wsUrl = wsUrl
          .replace(/__hostname=index\.html/g, '__hostname=localhost')
          .replace(/hostname=index\.html/g, 'hostname=localhost');

        if (wsUrl !== originalUrl) {
          console.log(`[Preload] Fixed hostname in WebSocket URL: ${originalUrl} -> ${wsUrl}`);
        }
      }

      super(wsUrl, protocols);
    }
  };

  Object.setPrototypeOf(InterceptedWebSocket, OriginalWebSocket);
  Object.getOwnPropertyNames(OriginalWebSocket).forEach((name) => {
    if (name !== 'prototype' && name !== 'length' && name !== 'name') {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(OriginalWebSocket, name);
        if (descriptor) {
          Object.defineProperty(InterceptedWebSocket, name, descriptor);
        }
      } catch (e) {
        // 忽略无法复制的属性
      }
    }
  });

  globalObj.WebSocket = InterceptedWebSocket;
}
