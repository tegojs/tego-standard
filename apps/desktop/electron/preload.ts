import { contextBridge, ipcRenderer } from 'electron';

// 获取 API 端口（从环境变量或默认值）
const appPort = process.env.APP_PORT || '3000';
const apiBaseUrl = `http://localhost:${appPort}`;
const wsBaseUrl = `ws://localhost:${appPort}`;

// 拦截 WebSocket 构造函数，修复 WebSocket URL
// 在 preload 脚本中，直接替换全局 WebSocket
// 使用 globalThis 以确保在 Node.js 和浏览器环境中都能工作
const globalObj = globalThis as any;
const OriginalWebSocket = globalObj.WebSocket;

globalObj.WebSocket = class extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    // 如果 URL 包含 index.html 或使用 app:// 协议，替换为正确的 WebSocket URL
    let wsUrl = typeof url === 'string' ? url : url.toString();

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

      // 构建新的 WebSocket URL
      wsUrl = `${wsBaseUrl}${path}${query}`;
      console.log(`[Preload] WebSocket URL redirected: ${url} -> ${wsUrl}`);
    }

    // 调用父类构造函数
    super(wsUrl, protocols);
  }
};

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
