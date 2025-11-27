import { contextBridge } from 'electron';

import { setupLocationFix } from './preload/location-fix';
import { setupTextEncoderPolyfill } from './preload/polyfills';
import { setupWebSocketClientFix } from './preload/websocket-client-fix';
import { getAppPort } from './utils/config';

// 获取 API 端口
const appPort = getAppPort();
const apiBaseUrl = `http://localhost:${appPort}`;
const wsBaseUrl = `ws://localhost:${appPort}`;

// 设置 polyfills
setupTextEncoderPolyfill();

// 修复 location
setupLocationFix();

// 修复 WebSocketClient 的 hostname
setupWebSocketClientFix();

// 获取修复函数和 location hostname，以便通过 contextBridge 暴露
const globalWindow = globalThis as any;
const locationHostname = globalWindow.__tachybase_location_hostname__;
const locationOrigin = globalWindow.__tachybase_location_origin__;
const hostnameFixer = globalWindow.__tachybase_fix_websocket_hostname__;

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

// 暴露 WebSocketClient 修复相关的全局属性到页面脚本的 window 对象
// 在上下文隔离模式下，需要通过 contextBridge 来桥接
contextBridge.exposeInMainWorld('__tachybase_location_hostname__', locationHostname);
contextBridge.exposeInMainWorld('__tachybase_location_origin__', locationOrigin);
if (typeof hostnameFixer === 'function') {
  contextBridge.exposeInMainWorld('__tachybase_fix_websocket_hostname__', hostnameFixer);
}

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
    __tachybase_location_hostname__?: string;
    __tachybase_location_origin__?: string;
    __tachybase_fix_websocket_hostname__?: (hostname: string) => string;
  }
}
