import { define, observable } from '@tachybase/schema';
import { getSubAppName } from '@tego/client';

import { Application } from './Application';

/**
 * WebSocketClient hostname 修复函数类型
 * 允许外部环境（如 Electron desktop）提供自定义的 hostname 修复逻辑
 *
 * @param hostname - 原始 hostname
 * @returns 修复后的 hostname，如果返回 null/undefined 或非字符串值，则使用原值
 */
type HostnameFixer = (hostname: string) => string | null | undefined;

declare global {
  interface Window {
    /**
     * WebSocketClient hostname 修复函数（可选）
     * 由特定环境（如 Electron desktop preload 脚本）提供
     * 用于在生成 WebSocket URL 时修复 hostname
     */
    __tachybase_fix_websocket_hostname__?: HostnameFixer;
  }
}

export type WebSocketClientOptions = {
  reconnectInterval?: number;
  reconnectAttempts?: number;
  pingInterval?: number;
  url?: string;
  basename?: string;
  protocols?: string | string[];
  onServerDown?: any;
};

export class WebSocketClient {
  protected _ws: WebSocket;
  protected _reconnectTimes = 0;
  protected events = [];
  protected options: WebSocketClientOptions;
  enabled: boolean;
  connected = false;
  serverDown = false;
  lastMessage = {};

  constructor(
    options: WebSocketClientOptions | boolean,
    private app: Application,
  ) {
    if (!options) {
      this.enabled = false;
      return;
    }
    this.options = options === true ? {} : options;
    this.enabled = true;
    define(this, {
      serverDown: observable.ref,
      connected: observable.ref,
      lastMessage: observable.ref,
    });
  }

  getURL() {
    if (!this.app) {
      return;
    }
    const options = this.app.getOptions();
    const apiBaseURL = options?.apiClient?.['baseURL'];
    if (!apiBaseURL) {
      return;
    }

    const locationHostname = (window as any).__tachybase_location_hostname__;
    const windowHostname = window.location.hostname;
    let hostname = locationHostname || windowHostname;

    // 扩展机制：允许外部环境（如 Electron desktop）提供 hostname 修复函数
    const hostnameFixer = (window as any).__tachybase_fix_websocket_hostname__;
    if (typeof hostnameFixer === 'function') {
      const fixedHostname = hostnameFixer(hostname);
      if (fixedHostname && typeof fixedHostname === 'string') {
        hostname = fixedHostname;
      }
    }

    const subApp = getSubAppName(this.app.getPublicPath());
    const queryString = subApp ? `?__appName=${subApp}` : `?__hostname=${hostname}`;
    const wsPath = this.options.basename || '/ws';
    const hostnameWasFixed = hostname !== window.location.hostname;

    if (this.options.url) {
      const url = new URL(this.options.url);
      if (hostnameWasFixed) {
        const protocol = url.protocol === 'wss:' ? 'wss' : 'ws';
        const port = url.port || '';
        const host = port ? `${hostname}:${port}` : hostname;
        return `${protocol}://${host}${wsPath}${queryString}`;
      }
      return `${this.options.url}${queryString}`;
    }

    try {
      const url = new URL(apiBaseURL);
      const finalHostname = hostnameWasFixed ? hostname : url.hostname;
      const port = url.port || '';
      const host = port ? `${finalHostname}:${port}` : finalHostname;
      return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${host}${wsPath}${queryString}`;
    } catch (error) {
      let port = location.port;
      if (!port && apiBaseURL) {
        try {
          const apiUrl = new URL(apiBaseURL);
          port = apiUrl.port;
        } catch (e) {
          // 忽略错误
        }
      }
      const host = port ? `${hostname}:${port}` : hostname;
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}${wsPath}${queryString}`;
    }
  }

  get reconnectAttempts() {
    return this.options?.reconnectAttempts || 30;
  }

  get reconnectInterval() {
    return this.options?.reconnectInterval || 1000;
  }

  get pingInterval() {
    return this.options?.pingInterval || 30000;
  }

  get readyState() {
    if (!this._ws) {
      return -1;
    }
    return this._ws.readyState;
  }

  connect() {
    if (!this.enabled) {
      return;
    }
    if (this._reconnectTimes === 0) {
      console.log('[tachybase-ws]: connecting...');
    }
    if (this._reconnectTimes >= this.reconnectAttempts) {
      return;
    }
    if (this.readyState === WebSocket.OPEN) {
      return;
    }
    this._reconnectTimes++;
    const ws = new WebSocket(this.getURL(), this.options.protocols);
    let pingIntervalTimer: any;
    ws.onopen = () => {
      console.log('[tachybase-ws]: connected.');
      this.serverDown = false;
      if (this._ws) {
        this.removeAllListeners();
      }
      this._reconnectTimes = 0;
      this._ws = ws;
      for (const { type, listener, options } of this.events) {
        this._ws.addEventListener(type, listener, options);
      }
      pingIntervalTimer = setInterval(() => this.send('ping'), this.pingInterval);
      this.connected = true;
    };
    ws.onerror = async () => {
      console.log('onerror', this.readyState, this._reconnectTimes);
    };
    ws.onclose = async (event) => {
      setTimeout(() => this.connect(), this.reconnectInterval);
      console.log('onclose', this.readyState, this._reconnectTimes, this.serverDown);
      this.connected = false;
      clearInterval(pingIntervalTimer);
      if (this._reconnectTimes >= Math.min(this.reconnectAttempts, 5)) {
        this.serverDown = true;
        this.emit('serverDown', event);
      }
    };
  }

  reconnect() {
    this._reconnectTimes = 0;
    this.connect();
  }

  close() {
    if (!this._ws) {
      return;
    }
    this._reconnectTimes = this.reconnectAttempts;
    return this._ws.close();
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (!this._ws) {
      return;
    }
    return this._ws.send(data);
  }

  on(type: string, listener: any, options?: boolean | AddEventListenerOptions) {
    this.events.push({ type, listener, options });
    if (!this._ws) {
      return;
    }
    this._ws.addEventListener(type, listener, options);
  }

  emit(type: string, args: any) {
    for (const event of this.events) {
      if (event.type === type) {
        event.listener(args);
      }
    }
  }

  off(type: string, listener: any, options?: boolean | EventListenerOptions) {
    let index = 0;
    for (const event of this.events) {
      if (event.type === type && event.listener === listener) {
        this.events.splice(index, 1);
        break;
      }
      index++;
    }
    if (!this._ws) {
      return;
    }
    this._ws.removeEventListener(type, listener, options);
  }

  removeAllListeners() {
    if (!this._ws) {
      return;
    }
    for (const { type, listener, options } of this.events) {
      this._ws.removeEventListener(type, listener, options);
    }
  }
}
