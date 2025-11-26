import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, protocol } from 'electron';

import { log } from '../utils/logger';
import { findWebDistPath } from '../utils/path-finder';
import { processHtmlContent } from './protocol/html-processor';
import { getMimeType, MIME_TYPES } from './protocol/mime-types';

/**
 * 处理协议请求
 */
function handleProtocolRequest(
  request: Electron.ProtocolRequest,
  callback: (response: Electron.ProtocolResponse) => void,
  webDistBasePath: string,
): void {
  const appPort = process.env.APP_PORT || '3000';
  let url = request.url.replace(/^app:\/\//, '');

  // 处理三个斜杠的情况（app:///path -> app://path）
  if (url.startsWith('/')) {
    url = url.slice(1);
  }

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  // 移除 hostname 前缀（如 index.html、admin 等）
  // 匹配格式：hostname/ 或 hostname:port/
  // 注意：只移除真正的 hostname，不要移除 assets/ 这样的路径前缀
  const originalUrl = url;
  // 只有当路径包含 / 时才尝试移除 hostname（避免误移除 assets/ 前缀）
  if (url.includes('/') && !url.startsWith('assets/') && !url.startsWith('static/')) {
    url = url.replace(/^[^/]+(?::\d+)?\//, '');
    if (url !== originalUrl) {
      log(`[Electron] Removed hostname prefix: ${request.url} -> app://${url}`);
    }
  }

  // 处理 index.html/ 前缀（可能是从 SPA 路由产生的）
  if (url.startsWith('index.html/')) {
    url = url.replace(/^index\.html\//, '');
    log(`[Electron] Fixed path: ${request.url} -> app://${url}`);
  }

  // 记录处理后的 URL，用于调试
  if (request.url.includes('assets/')) {
    log(`[Electron] Processing assets request: ${request.url} -> ${url}`);
  }

  // 插件路径需要重定向到后端服务器
  // 注意：对于自定义协议 app://，webRequest 拦截器可能无法拦截，
  // 所以我们需要在协议处理器中直接处理重定向
  if (url.startsWith('static/plugins/') || url.includes('@tachybase/')) {
    // 构建后端 URL
    const queryIndex = request.url.indexOf('?');
    const queryString = queryIndex !== -1 ? request.url.substring(queryIndex) : '';
    const backendUrl = `http://localhost:${appPort}/${url}${queryString}`;
    log(`[Electron] Redirecting plugin path to backend: ${request.url} -> ${backendUrl}`);
    // 返回重定向响应
    // 注意：protocol callback 不支持直接重定向，我们需要返回一个特殊的响应
    // 但实际上，我们应该让浏览器发起新的 HTTP 请求
    // 由于 protocol handler 无法直接重定向，我们返回错误，让拦截器处理
    // 但如果拦截器没有处理，我们可以尝试返回一个包含重定向信息的响应
    callback({ error: -6 });
    return;
  }

  if (url === '' || url === '/' || url === 'index.html') {
    url = 'index.html';
  }

  const queryIndex = url.indexOf('?');
  if (queryIndex !== -1) {
    url = url.substring(0, queryIndex);
  }

  // 处理 loading.html
  if (url === 'loading.html') {
    const appPath = app.getAppPath();
    const possibleLoadingPaths = [
      path.join(appPath, 'app', 'loading.html'),
      path.join(process.resourcesPath, 'app.asar', 'app', 'loading.html'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'app', 'loading.html'),
      path.join(process.resourcesPath, 'app', 'loading.html'),
    ];

    for (const possiblePath of possibleLoadingPaths) {
      try {
        fs.accessSync(possiblePath, fs.constants.F_OK);
        const htmlContent = fs.readFileSync(possiblePath, 'utf8');
        callback({
          data: Buffer.from(htmlContent, 'utf8'),
          mimeType: 'text/html',
        });
        return;
      } catch (e) {
        // 继续尝试下一个路径
      }
    }

    log(`[Electron] loading.html not found in any location`, 'error');
    callback({ error: -6 });
    return;
  }

  const filePath = path.join(webDistBasePath, url);
  log(`[Electron] Protocol request: ${request.url} -> ${url} -> ${filePath}`);
  log(`[Electron] WebDist base path: ${webDistBasePath}`);
  log(`[Electron] File exists: ${fs.existsSync(filePath)}`);

  if (!fs.existsSync(filePath)) {
    const ext = path.extname(url).toLowerCase();
    const isStaticResource = ext && ext !== '' && Object.keys(MIME_TYPES).includes(ext);

    if (isStaticResource) {
      // 尝试列出 webDistBasePath 目录内容，帮助调试
      try {
        const dirContents = fs.readdirSync(webDistBasePath);
        log(`[Electron] WebDist directory contents: ${dirContents.join(', ')}`, 'error');
        if (url.startsWith('assets/')) {
          const assetsPath = path.join(webDistBasePath, 'assets');
          if (fs.existsSync(assetsPath)) {
            const assetsContents = fs.readdirSync(assetsPath);
            log(`[Electron] Assets directory contents: ${assetsContents.slice(0, 10).join(', ')}...`, 'error');
          } else {
            log(`[Electron] Assets directory does not exist: ${assetsPath}`, 'error');
          }
        }
      } catch (e) {
        log(`[Electron] Could not read webDist directory: ${e}`, 'error');
      }
      log(`[Electron] Static resource not found: app://${url} (${filePath})`, 'error');
      callback({ error: -6 });
      return;
    }

    // SPA 路由，返回 index.html
    log(`[Electron] Route path not found, serving index.html for SPA routing: app://${url}`);
    const indexHtmlPath = path.join(webDistBasePath, 'index.html');

    if (!fs.existsSync(indexHtmlPath)) {
      log(`[Electron] index.html not found at: ${indexHtmlPath}`, 'error');
      callback({ error: -6 });
      return;
    }

    try {
      let htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
      htmlContent = processHtmlContent(htmlContent);
      callback({
        data: Buffer.from(htmlContent, 'utf8'),
        mimeType: 'text/html',
      });
      return;
    } catch (error: any) {
      log(`[Electron] Error reading index.html: ${error.message}`, 'error');
      callback({ error: -6 });
      return;
    }
  }

  try {
    if (url === 'index.html' || url.endsWith('.html')) {
      let htmlContent = fs.readFileSync(filePath, 'utf8');
      htmlContent = processHtmlContent(htmlContent);
      callback({
        data: Buffer.from(htmlContent, 'utf8'),
        mimeType: 'text/html',
      });
    } else {
      const fileContent = fs.readFileSync(filePath);
      const mimeType = getMimeType(url);
      callback({
        data: fileContent,
        mimeType: mimeType,
      });
    }
  } catch (error: any) {
    log(`[Electron] Error reading file ${filePath}: ${error.message}`, 'error');
    callback({ error: -6 });
  }
}

/**
 * 注册自定义协议
 */
export function registerCustomProtocol(isDev: boolean): void {
  if (isDev) {
    return;
  }

  const webDistBasePath = findWebDistPath();

  if (!webDistBasePath) {
    log('[Electron] ⚠ web-dist not found, custom protocol may not work', 'warn');
    return;
  }

  protocol.registerBufferProtocol('app', (request, callback) => {
    handleProtocolRequest(request, callback, webDistBasePath);
  });

  log(`[Electron] Custom protocol "app://" registered (web-dist: ${webDistBasePath})`);
}
