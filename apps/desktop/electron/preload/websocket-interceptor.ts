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
    console.warn('[Preload] WebSocket not available, cannot install interceptor');
    return;
  }

  // 立即替换全局 WebSocket，确保在页面脚本执行前就生效
  const InterceptedWebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      // 统一处理 URL，确保无论是字符串还是 URL 对象都能正确转换
      let wsUrl: string;
      try {
        if (typeof url === 'string') {
          wsUrl = url;
        } else if (url instanceof URL) {
          // URL 对象转换为字符串，使用 href 属性确保获取完整 URL
          wsUrl = url.href;
        } else {
          wsUrl = String(url);
        }
      } catch (e) {
        console.warn('[Preload] Error converting WebSocket URL:', e);
        wsUrl = String(url);
      }
      const originalUrl = wsUrl;

      const isDesktop =
        typeof window !== 'undefined' &&
        (window.location.protocol === 'app:' ||
          window.location.hostname === 'index.html' ||
          window.location.hostname === 'admin');

      // 检查是否需要重定向（包括 ws://index.html:port 或 ws://admin:port 格式）
      // 优先检查 URL 开头，然后检查是否包含无效的 hostname
      const hasInvalidHostname =
        wsUrl.startsWith('ws://index.html') ||
        wsUrl.startsWith('wss://index.html') ||
        wsUrl.startsWith('app://') ||
        wsUrl.startsWith('ws://admin') ||
        wsUrl.startsWith('wss://admin') ||
        /^(ws|wss):\/\/index\.html/.test(wsUrl) ||
        /^(ws|wss):\/\/admin/.test(wsUrl) ||
        wsUrl.includes('index.html:') ||
        wsUrl.includes('admin:');

      // 如果 URL 包含无效的 hostname，或者是在桌面环境中，都需要检查和修复
      const needsFullRedirect =
        hasInvalidHostname || (isDesktop && (wsUrl.includes('index.html') || wsUrl.includes('admin')));

      // 调试日志 - 记录所有包含 index.html 或 admin 的 WebSocket 连接尝试
      if (hasInvalidHostname || (isDesktop && (wsUrl.includes('index.html') || wsUrl.includes('admin')))) {
        console.log(
          `[Preload] WebSocket interceptor called with URL: ${originalUrl} (isDesktop: ${isDesktop}, needsFullRedirect: ${needsFullRedirect})`,
        );
      }

      if (needsFullRedirect) {
        // 使用正则表达式提取协议、路径和查询参数
        // 匹配格式：ws://index.html:port/path?query 或 ws://index.html/path?query
        // 也匹配 ws://admin:port/path?query 或 ws://admin/path?query
        // 改进的正则：明确捕获端口号（如果存在）
        const wsMatch = wsUrl.match(/^(ws|wss):\/\/(index\.html|admin)(?::(\d+))?(\/[^?]*)?(\?.*)?/);

        if (wsMatch) {
          // 组1是协议 (ws 或 wss)
          // 组2是hostname (index.html 或 admin)
          // 组3是端口号（如果存在）
          // 组4是路径（如果存在）
          // 组5是查询参数（如果存在）
          const path = wsMatch[4] || '/ws'; // 组4是路径
          let query = wsMatch[5] || ''; // 组5是查询参数

          // 修复查询参数中的 hostname（包括 admin）
          if (query) {
            const originalQuery = query;
            query = query
              .replace(/__hostname=index\.html/g, '__hostname=localhost')
              .replace(/hostname=index\.html/g, 'hostname=localhost')
              .replace(/__hostname=admin/g, '__hostname=localhost')
              .replace(/hostname=admin/g, 'hostname=localhost');
            if (query !== originalQuery) {
              console.log(`[Preload] Fixed query params: ${originalQuery} -> ${query}`);
            }
          }

          wsUrl = `${wsBaseUrl}${path}${query}`;
          console.log(`[Preload] WebSocket URL redirected: ${originalUrl} -> ${wsUrl}`);
        } else {
          // 回退逻辑：尝试从 URL 中提取路径和查询参数
          // 这种情况可能发生在 URL 格式不完全匹配正则表达式时
          console.log(`[Preload] WebSocket URL regex match failed, using fallback logic for: ${originalUrl}`);
          let path = '/ws';
          let query = '';

          // 尝试提取路径和查询参数（支持多种格式）
          // 首先尝试匹配 /ws 路径
          const wsPathMatch = wsUrl.match(/(\/ws[^?]*)(\?.*)?/);
          if (wsPathMatch) {
            path = wsPathMatch[1];
            query = wsPathMatch[2] || '';
          } else {
            // 尝试提取任何路径（以 / 开头）
            const generalPathMatch = wsUrl.match(/\/([^?]+)(\?.*)?/);
            if (generalPathMatch) {
              path = `/${generalPathMatch[1]}`;
              query = generalPathMatch[2] || '';
            } else {
              // 如果都没有匹配到，尝试从 URL 中提取查询参数
              const queryMatch = wsUrl.match(/\?.*/);
              if (queryMatch) {
                query = queryMatch[0];
              }
            }
          }

          // 修复查询参数中的 hostname（包括 admin）
          if (query) {
            const originalQuery = query;
            query = query
              .replace(/__hostname=index\.html/g, '__hostname=localhost')
              .replace(/hostname=index\.html/g, 'hostname=localhost')
              .replace(/__hostname=admin/g, '__hostname=localhost')
              .replace(/hostname=admin/g, 'hostname=localhost');
            if (query !== originalQuery) {
              console.log(`[Preload] Fixed query params in fallback: ${originalQuery} -> ${query}`);
            }
          }

          wsUrl = `${wsBaseUrl}${path}${query}`;
          console.log(`[Preload] WebSocket URL redirected (fallback): ${originalUrl} -> ${wsUrl}`);
        }
      } else if (isDesktop) {
        // 处理其他需要修复的 WebSocket URL
        wsUrl = wsUrl
          .replace(/^(ws|wss):\/\/index\.html(:\d+)?/, (match, protocol, port) => {
            return `${protocol}://localhost${port || `:${appPort}`}`;
          })
          .replace(/^(ws|wss):\/\/index\.html:(\d+)/, (match, protocol, port) => {
            return `${protocol}://localhost:${port}`;
          })
          .replace(/^(ws|wss):\/\/admin(:\d+)?/, (match, protocol, port) => {
            return `${protocol}://localhost${port || `:${appPort}`}`;
          })
          .replace(/^(ws|wss):\/\/admin:(\d+)/, (match, protocol, port) => {
            return `${protocol}://localhost:${port}`;
          })
          .replace(/^(ws|wss):\/\/([^/:]+)(:\d+)/, (match, protocol, hostname, port) => {
            if (
              hostname === 'index.html' ||
              hostname === 'admin' ||
              (typeof window !== 'undefined' &&
                (window.location.hostname === 'index.html' || window.location.hostname === 'admin') &&
                hostname === window.location.hostname)
            ) {
              return `${protocol}://localhost${port}`;
            }
            return match;
          });

        // 修复查询参数中的 hostname（包括 admin）
        wsUrl = wsUrl
          .replace(/__hostname=index\.html/g, '__hostname=localhost')
          .replace(/hostname=index\.html/g, 'hostname=localhost')
          .replace(/__hostname=admin/g, '__hostname=localhost')
          .replace(/hostname=admin/g, 'hostname=localhost');

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

  // 立即替换全局 WebSocket
  // 使用 defineProperty 确保拦截器不能被覆盖
  try {
    // 先尝试替换 globalThis/globalObj
    Object.defineProperty(globalObj, 'WebSocket', {
      value: InterceptedWebSocket,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    // 也替换 window.WebSocket（如果存在）
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'WebSocket', {
        value: InterceptedWebSocket,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    // 验证拦截器已安装
    console.log('[Preload] WebSocket interceptor installed successfully');

    // 验证替换是否成功
    const globalReplaced = globalObj.WebSocket === InterceptedWebSocket;
    const windowReplaced = typeof window === 'undefined' || window.WebSocket === InterceptedWebSocket;

    if (globalReplaced && windowReplaced) {
      console.log('[Preload] WebSocket interceptor verified: global and window WebSocket replaced');
    } else {
      console.warn(`[Preload] WebSocket interceptor warning: global=${globalReplaced}, window=${windowReplaced}`);
    }
  } catch (error) {
    // 如果 defineProperty 失败，回退到直接赋值
    console.warn('[Preload] Failed to use defineProperty, falling back to direct assignment:', error);
    try {
      globalObj.WebSocket = InterceptedWebSocket;
      if (typeof window !== 'undefined') {
        (window as any).WebSocket = InterceptedWebSocket;
      }
      console.log('[Preload] WebSocket interceptor installed via direct assignment');
    } catch (e) {
      console.error('[Preload] Failed to install WebSocket interceptor:', e);
    }
  }
}
