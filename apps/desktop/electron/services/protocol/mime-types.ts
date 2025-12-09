/**
 * MIME 类型映射
 */
export const MIME_TYPES: { [key: string]: string } = {
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
export function getMimeType(filePath: string): string {
  const ext = require('node:path').extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}
