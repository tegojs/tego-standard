import { contextBridge } from 'electron';

import { setupLocationFix } from './preload/location-fix';
import { setupTextEncoderPolyfill } from './preload/polyfills';
import { setupWebSocketInterceptor } from './preload/websocket-interceptor';

// 获取 API 端口
const appPort = process.env.APP_PORT || '3000';
const apiBaseUrl = `http://localhost:${appPort}`;
const wsBaseUrl = `ws://localhost:${appPort}`;

// 设置 polyfills
setupTextEncoderPolyfill();

// 修复 location
setupLocationFix();

// 拦截 WebSocket
setupWebSocketInterceptor();

// 暴露受保护的方法给渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  api: {
    baseURL: apiBaseUrl,
    wsURL: wsBaseUrl,
  },
});

// 类型声明
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
