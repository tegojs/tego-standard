import * as fs from 'node:fs';
import * as path from 'node:path';

import { protocol } from 'electron';

import { log } from '../utils/logger';
import { findWebDistPath } from '../utils/path-finder';

// MIME 类型映射
const MIME_TYPES: { [key: string]: string } = {
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 获取文件的 MIME 类型
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 处理 HTML 文件，修改静态资源路径
 */
function processHtmlContent(htmlContent: string): string {
  // 不设置 base 标签，避免影响 API 请求
  // 只修改静态资源路径（CSS、JS、图片等）为 app:// 协议
  // 这样 API 请求（/api/*, /ws 等）会使用相对路径，指向正确的后端服务器

  // 将静态资源的绝对路径转换为 app:// 协议（移除开头的斜杠）
  // 只匹配静态资源，不匹配 API 路径
  htmlContent = htmlContent.replace(
    /href="\/(assets\/[^"]+|global\.css|favicon\.ico|manifest\.webmanifest)"/g,
    'href="app://$1"',
  );
  htmlContent = htmlContent.replace(/src="\/(assets\/[^"]+|browser-checker\.js)"/g, 'src="app://$1"');

  // 处理 /static/ 路径（插件静态资源）
  htmlContent = htmlContent.replace(/(href|src)="\/static\/([^"]+)"/g, '$1="app://static/$2"');

  return htmlContent;
}

/**
 * 处理协议请求
 */
function handleProtocolRequest(
  request: Electron.ProtocolRequest,
  callback: (response: Electron.ProtocolResponse) => void,
  webDistBasePath: string,
): void {
  // 解析 URL：app:///path 或 app://path
  let url = request.url.replace(/^app:\/\//, ''); // 移除 'app://' 前缀

  // 移除开头的斜杠（如果有）
  if (url.startsWith('/')) {
    url = url.slice(1);
  }

  // 移除尾部的斜杠（如果有）
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  // 处理包含 index.html/ 的路径（错误路径，需要修正）
  // 例如：index.html/static/plugins/... -> static/plugins/...
  if (url.startsWith('index.html/')) {
    url = url.replace(/^index\.html\//, '');
    log(`[Electron] Fixed path: ${request.url} -> ${url}`);
  }

  // 处理根路径和 index.html
  if (url === '' || url === '/' || url === 'index.html') {
    url = 'index.html';
  }

  // 移除查询参数（如果有）
  const queryIndex = url.indexOf('?');
  if (queryIndex !== -1) {
    url = url.substring(0, queryIndex);
  }

  const filePath = path.join(webDistBasePath, url);

  // 添加调试日志
  log(`[Electron] Protocol request: ${request.url} -> ${url} -> ${filePath}`);

  if (!fs.existsSync(filePath)) {
    log(`[Electron] File not found: app://${url} (${filePath})`, 'error');
    // 列出目录内容以便调试
    try {
      const dir = path.dirname(filePath);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        log(`[Electron] Directory contents: ${files.join(', ')}`, 'error');
      }
    } catch (e) {
      // 忽略错误
    }
    callback({ error: -6 }); // ERR_FILE_NOT_FOUND
    return;
  }

  try {
    // 如果是 HTML 文件，需要修改内容
    if (url === 'index.html' || url.endsWith('.html')) {
      let htmlContent = fs.readFileSync(filePath, 'utf8');
      htmlContent = processHtmlContent(htmlContent);

      callback({
        data: Buffer.from(htmlContent, 'utf8'),
        mimeType: 'text/html',
      });
    } else {
      // 其他资源文件：读取文件内容并返回
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

  // 查找 web-dist 目录
  const webDistBasePath = findWebDistPath();

  if (!webDistBasePath) {
    log('[Electron] ⚠ web-dist not found, custom protocol may not work', 'warn');
    return;
  }

  // 注册 app:// 协议，用于加载 web-dist 中的资源
  // 使用 registerBufferProtocol 处理所有文件，因为需要修改 HTML 内容
  protocol.registerBufferProtocol('app', (request, callback) => {
    handleProtocolRequest(request, callback, webDistBasePath);
  });

  log(`[Electron] Custom protocol "app://" registered (web-dist: ${webDistBasePath})`);
}
