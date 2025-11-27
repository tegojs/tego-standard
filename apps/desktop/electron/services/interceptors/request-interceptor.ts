import { BrowserWindow } from 'electron';

import { getAppPort } from '../../utils/config';
import { log } from '../../utils/logger';
import { isApiRequest, needsRedirect, redirectApiUrl } from '../../utils/url-redirector';

/**
 * 设置 CORS 响应头拦截器
 *
 * 在 Electron 中，CORS 的处理逻辑：
 * 1. 虽然我们在 onBeforeRequest 中会将 app:// 协议的请求重定向到 http://localhost:port，
 *    但浏览器仍然会进行 CORS 检查（因为请求是从 app:// 协议发起的）
 * 2. 为了确保所有请求都能正常工作，我们需要为所有本地 API 请求添加 CORS 头
 * 3. 在 Electron 本地应用中，我们可以安全地允许所有来源和所有请求头
 *
 * 注意：CORS 规范要求明确列出所有允许的请求头，不能使用通配符
 */
function setupCorsHeaders(window: BrowserWindow): void {
  const appPort = getAppPort();

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url;
    const isApiRequest =
      url.includes('/api/') || url.includes('/ws') || url.includes('/adapters/') || url.includes('/static/');
    const isLocalhost = url.includes(`localhost:${appPort}`) || url.includes(`127.0.0.1:${appPort}`);

    // 为所有本地 API 请求设置 CORS 头
    // 在 Electron 本地应用中，允许所有来源是安全的
    if (isApiRequest && isLocalhost) {
      // 基础允许的请求头列表
      const baseAllowedHeaders = [
        'Content-Type',
        'Accept',
        'Origin',
        'X-Requested-With',
        'Authorization',
        'X-With-ACL-Meta',
        'X-Role',
        'x-timezone',
        'X-Timezone',
        'x-hostname',
        'X-Hostname',
        'x-authenticator',
        'X-Authenticator',
      ];

      // 在 Electron 中，onHeadersReceived 的 details 没有 requestHeaders 属性
      // 由于这是本地应用，我们可以直接允许所有常见的自定义头
      // 如果需要动态处理，应该在 onBeforeRequest 中处理预检请求
      const allowedHeaders = baseAllowedHeaders;

      const responseHeaders = {
        ...details.responseHeaders,
        // 允许所有来源（Electron 本地应用，安全性由应用本身控制）
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        // 明确列出所有允许的请求头（CORS 规范要求）
        'Access-Control-Allow-Headers': allowedHeaders,
        'Access-Control-Allow-Credentials': ['true'],
        'Access-Control-Expose-Headers': ['Content-Length', 'Content-Type', 'X-Total-Count'],
      };

      // 处理 OPTIONS 预检请求
      // 在 Electron 中，预检请求仍然会发生，我们需要正确处理
      if (details.method === 'OPTIONS') {
        callback({
          responseHeaders,
          statusLine: 'HTTP/1.1 204 No Content',
        });
        return;
      }

      callback({ responseHeaders });
      return;
    }

    callback({});
  });
}

/**
 * 处理插件模块请求重定向
 */
function handlePluginRequest(url: string, appPort: string): string | null {
  // 检查是否是插件路径
  const isPluginPath = url.includes('/static/plugins/') || url.includes('@tachybase/');
  if (!isPluginPath) {
    return null;
  }

  let path = url;
  // 移除协议前缀
  path = path.replace(/^(app|http|https|ws|wss):\/\//, '');
  // 移除 hostname 前缀（包括 admin、localhost 等）
  path = path.replace(/^[^/]+(?::\d+)?\//, '');
  path = path.replace(/^index\.html\//, '');
  // 移除开头的斜杠
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  // 检查是否是插件路径（移除 hostname 后）
  if (path.startsWith('static/plugins/')) {
    // 保留查询参数
    const queryIndex = url.indexOf('?');
    const queryString = queryIndex !== -1 ? url.substring(queryIndex) : '';
    return `http://localhost:${appPort}/${path}${queryString}`;
  }

  return null;
}

/**
 * 修复包含 index.html/ 的 app:// 路径
 */
function fixAppProtocolPath(url: string, redirectHistory: Set<string>): string | null {
  if (!url.startsWith('app://') || !url.includes('index.html/')) {
    return null;
  }

  if (url === 'app://index.html/') {
    return null; // 让协议处理器处理
  }

  if (redirectHistory.has(url)) {
    redirectHistory.clear();
    return null; // 避免循环
  }

  redirectHistory.add(url);
  if (redirectHistory.size > 10) {
    const first = redirectHistory.values().next().value;
    if (first) {
      redirectHistory.delete(first);
    }
  }

  return url.replace(/app:\/\/index\.html\//, 'app://');
}

/**
 * 设置 API 请求拦截器
 */
export function setupApiRequestInterceptor(window: BrowserWindow, isDev: boolean): void {
  if (isDev) {
    return;
  }

  const appPort = getAppPort();
  const redirectHistory = new Set<string>();

  setupCorsHeaders(window);

  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;

    // 如果已经是正确的 URL，直接放行
    if (url.startsWith(`http://localhost:${appPort}/`) || url.startsWith(`http://127.0.0.1:${appPort}/`)) {
      callback({});
      return;
    }

    // 处理插件模块请求（优先处理，在协议处理器之前）
    const pluginRedirect = handlePluginRequest(url, appPort);
    if (pluginRedirect) {
      log(`[Electron] [Plugin] Interceptor redirecting: ${url} -> ${pluginRedirect}`);
      callback({ redirectURL: pluginRedirect });
      return;
    }

    // 修复 app:// 协议路径
    const fixedPath = fixAppProtocolPath(url, redirectHistory);
    if (fixedPath) {
      log(`[Electron] Fixing path: ${url} -> ${fixedPath}`);
      callback({ redirectURL: fixedPath });
      return;
    }

    // 清除重定向历史
    if (!url.includes('index.html/')) {
      redirectHistory.clear();
    }

    // 处理 WebSocket 请求
    if ((url.startsWith('ws://') || url.startsWith('wss://')) && (url.includes('index.html') || needsRedirect(url))) {
      const redirectUrl = redirectApiUrl(url, appPort);
      log(`[Electron] Redirecting WebSocket request: ${url} -> ${redirectUrl}`);
      callback({ redirectURL: redirectUrl });
      return;
    }

    // 处理其他 API 请求
    if (isApiRequest(url) && needsRedirect(url)) {
      const redirectUrl = redirectApiUrl(url, appPort);
      log(`[Electron] Redirecting API request: ${url} -> ${redirectUrl}`);
      callback({ redirectURL: redirectUrl });
      return;
    }

    callback({});
  });
}
