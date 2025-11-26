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
  let url = request.url.replace(/^app:\/\//, '');

  if (url.startsWith('/')) {
    url = url.slice(1);
  }

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  // 移除 hostname 前缀
  const originalUrl = url;
  url = url.replace(/^[^/]+(?::\d+)?\//, '');
  if (url !== originalUrl) {
    log(`[Electron] Removed hostname prefix: ${request.url} -> app://${url}`);
  }

  if (url.startsWith('index.html/')) {
    url = url.replace(/^index\.html\//, '');
    log(`[Electron] Fixed path: ${request.url} -> app://${url}`);
  }

  // 插件路径由请求拦截器处理
  if (url.startsWith('static/plugins/') || url.includes('@tachybase/')) {
    log(`[Electron] Skipping protocol handler for plugin path: ${request.url} (should be redirected to backend)`);
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

  if (!fs.existsSync(filePath)) {
    const ext = path.extname(url).toLowerCase();
    const isStaticResource = ext && ext !== '' && Object.keys(MIME_TYPES).includes(ext);

    if (isStaticResource) {
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
