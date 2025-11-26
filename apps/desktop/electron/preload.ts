import { contextBridge, ipcRenderer } from 'electron';

// 获取 API 端口（从环境变量或默认值）
const appPort = process.env.APP_PORT || '3000';
const apiBaseUrl = `http://localhost:${appPort}`;
const wsBaseUrl = `ws://localhost:${appPort}`;

// TextEncoder/TextDecoder polyfill for Electron
// 确保在渲染进程中 TextEncoder 和 TextDecoder 可用
// 虽然现代浏览器和 Node.js 都支持它们，但在某些 Electron 环境中可能需要 polyfill
(function () {
  const globalObj = globalThis as any;

  // 确保 TextEncoder 和 TextDecoder 在全局范围内可用
  // 优先使用 Node.js 的 util.TextEncoder，因为它更可靠
  let TextEncoderClass: typeof TextEncoder | null = null;
  let TextDecoderClass: typeof TextDecoder | null = null;

  // 首先尝试使用 Node.js 的 util.TextEncoder
  try {
    const util = require('node:util');
    if (util.TextEncoder && typeof util.TextEncoder === 'function') {
      TextEncoderClass = util.TextEncoder;
      TextDecoderClass = util.TextDecoder;
      console.log('[Preload] TextEncoder/TextDecoder loaded from Node.js util');
    }
  } catch (e) {
    // Node.js util 不可用，继续尝试其他方式
  }

  // 如果 Node.js util 不可用，尝试使用浏览器内置的实现
  if (!TextEncoderClass) {
    try {
      if (typeof globalObj.TextEncoder === 'function') {
        TextEncoderClass = globalObj.TextEncoder;
        TextDecoderClass = globalObj.TextDecoder;
        console.log('[Preload] TextEncoder/TextDecoder already available in global scope');
      } else if (typeof window !== 'undefined' && typeof window.TextEncoder === 'function') {
        TextEncoderClass = window.TextEncoder;
        TextDecoderClass = window.TextDecoder;
        console.log('[Preload] TextEncoder/TextDecoder loaded from window');
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // 如果找到了 TextEncoder 和 TextDecoder，确保它们在全局范围内可用
  if (TextEncoderClass && TextDecoderClass) {
    // 确保它们是构造函数
    try {
      const testEncoder = new TextEncoderClass();
      const testDecoder = new TextDecoderClass();
      if (testEncoder && testDecoder) {
        // 在多个全局对象上设置，确保所有代码都能访问
        globalObj.TextEncoder = TextEncoderClass;
        globalObj.TextDecoder = TextDecoderClass;

        // 也在 window 对象上设置（如果存在）
        if (typeof window !== 'undefined') {
          (window as any).TextEncoder = TextEncoderClass;
          (window as any).TextDecoder = TextDecoderClass;
        }

        console.log('[Preload] TextEncoder/TextDecoder polyfill installed and verified');
      }
    } catch (e) {
      console.warn('[Preload] TextEncoder/TextDecoder verification failed:', e);
    }
  } else {
    console.warn('[Preload] Could not find TextEncoder/TextDecoder implementation');
  }
})();

// 修复 window.location，避免生成错误的 WebSocket URL
// 在 app:// 协议下，location.hostname 可能是 'index.html'，需要修复
// 注意：location.hostname 可能是不可配置的，所以不能直接重定义
// 我们通过拦截 WebSocket 和 API 请求来修复 URL，而不是修改 location 对象
(function () {
  const globalWindow = globalThis as any;

  // 等待 window 对象可用
  if (typeof globalWindow !== 'undefined') {
    try {
      // 先尝试获取原始的 location 对象
      const location = globalWindow.location || (globalWindow.window && globalWindow.window.location);

      if (location) {
        // 检查 hostname 是否为 'index.html'
        const originalHostname = location.hostname;

        if (originalHostname === 'index.html' || !originalHostname || originalHostname === '') {
          // 由于 location.hostname 可能是不可配置的，我们不能直接重定义它
          // 相反，我们在 window 对象上设置一个辅助属性，供应用代码使用
          // 同时通过拦截 WebSocket 和 fetch/XMLHttpRequest 来修复 URL
          try {
            // 设置一个辅助属性，供应用代码使用
            Object.defineProperty(globalWindow, '__tachybase_location_hostname__', {
              value: 'localhost',
              writable: false,
              configurable: false,
              enumerable: false,
            });
            console.log('[Preload] Set __tachybase_location_hostname__ to localhost');
          } catch (e) {
            console.warn('[Preload] Could not set __tachybase_location_hostname__:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[Preload] Error checking location:', e);
    }
  }
})();

// 拦截 WebSocket 构造函数，修复 WebSocket URL
// 在 preload 脚本中，直接替换全局 WebSocket
// 使用 globalThis 以确保在 Node.js 和浏览器环境中都能工作
const globalObj = globalThis as any;
const OriginalWebSocket = globalObj.WebSocket;

// 在页面加载前就替换 WebSocket，确保所有 WebSocket 创建都被拦截
if (OriginalWebSocket) {
  // 创建新的 WebSocket 类
  const InterceptedWebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      // 如果 URL 包含 index.html 或使用 app:// 协议，替换为正确的 WebSocket URL
      let wsUrl = typeof url === 'string' ? url : url.toString();
      const originalUrl = wsUrl;

      // 检测 desktop 环境
      const isDesktop =
        typeof window !== 'undefined' &&
        (window.location.protocol === 'app:' || window.location.hostname === 'index.html');

      // 检查是否需要完全重定向（app:// 协议或包含 index.html 的完整 URL）
      const needsFullRedirect =
        wsUrl.startsWith('app://') ||
        wsUrl.startsWith('ws://index.html') ||
        wsUrl.startsWith('wss://index.html') ||
        wsUrl.startsWith('http://index.html');

      if (needsFullRedirect) {
        // 提取路径和查询参数
        let path = '/ws';
        let query = '';

        // 尝试提取路径部分（匹配 /ws 或 /ws/...）
        const pathMatch = wsUrl.match(/(\/ws[^?]*)(\?.*)?/);
        if (pathMatch) {
          path = pathMatch[1];
          query = pathMatch[2] || '';
        } else {
          // 如果没有找到 /ws，尝试提取其他路径
          const generalPathMatch = wsUrl.match(/\/([^?]+)(\?.*)?/);
          if (generalPathMatch) {
            path = `/${generalPathMatch[1]}`;
            query = generalPathMatch[2] || '';
          }
        }

        // 修复查询参数中的 hostname（处理多种可能的情况）
        if (query) {
          query = query
            .replace(/__hostname=index\.html/g, '__hostname=localhost')
            .replace(/hostname=index\.html/g, 'hostname=localhost');
        }

        // 构建新的 WebSocket URL
        wsUrl = `${wsBaseUrl}${path}${query}`;
        console.log(`[Preload] WebSocket URL redirected: ${originalUrl} -> ${wsUrl}`);
      } else if (isDesktop) {
        // 在 desktop 环境下，修复 URL 中的 hostname
        // 处理 ws://index.html:port 或 ws://hostname:port 的情况
        wsUrl = wsUrl
          .replace(/^(ws|wss):\/\/index\.html(:\d+)?/, (match, protocol, port) => {
            return `${protocol}://localhost${port || `:${appPort}`}`;
          })
          .replace(/^(ws|wss):\/\/([^/:]+)(:\d+)/, (match, protocol, hostname, port) => {
            // 如果 hostname 不是 localhost 且不是有效的域名，替换为 localhost
            if (hostname === 'index.html' || hostname === window.location.hostname) {
              return `${protocol}://localhost${port}`;
            }
            return match;
          });

        // 修复查询参数中的 hostname
        wsUrl = wsUrl
          .replace(/__hostname=index\.html/g, '__hostname=localhost')
          .replace(/hostname=index\.html/g, 'hostname=localhost');

        // 如果 URL 被修改了，记录日志
        if (wsUrl !== originalUrl) {
          console.log(`[Preload] Fixed hostname in WebSocket URL: ${originalUrl} -> ${wsUrl}`);
        }
      }

      // 调用父类构造函数
      super(wsUrl, protocols);
    }
  };

  // 复制静态属性和方法
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

  // 替换全局 WebSocket
  globalObj.WebSocket = InterceptedWebSocket;
}

// 暴露受保护的方法给渲染进程
contextBridge.exposeInMainWorld('electron', {
  // 平台信息
  platform: process.platform,

  // 版本信息
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  // API 配置
  api: {
    baseURL: apiBaseUrl,
    wsURL: wsBaseUrl,
  },

  // 可以在这里添加更多需要暴露给渲染进程的 API
  // 例如：文件操作、系统通知等
});

// 类型声明（供 TypeScript 使用）
declare global {
  interface Window {
    electron: {
      platform: string;
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
      api: {
        baseURL: string;
        wsURL: string;
      };
    };
  }
}
