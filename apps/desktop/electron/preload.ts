import { contextBridge, ipcRenderer } from 'electron';

// 获取 API 端口（从环境变量或默认值）
const appPort = process.env.APP_PORT || '3000';
const apiBaseUrl = `http://localhost:${appPort}`;
const wsBaseUrl = `ws://localhost:${appPort}`;

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

      // 检查是否需要重定向
      const needsRedirect =
        wsUrl.includes('index.html') ||
        wsUrl.startsWith('app://') ||
        wsUrl.startsWith('ws://index.html') ||
        wsUrl.startsWith('http://index.html');

      if (needsRedirect) {
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
      } else {
        // 即使不需要重定向，也检查查询参数中的 hostname
        const queryMatch = wsUrl.match(/\?.*/);
        if (queryMatch && queryMatch[0].includes('__hostname=index.html')) {
          wsUrl = wsUrl.replace(/__hostname=index\.html/g, '__hostname=localhost');
          console.log(`[Preload] Fixed hostname in WebSocket URL: ${wsUrl}`);
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
