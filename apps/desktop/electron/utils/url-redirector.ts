/**
 * 检查是否是 API 请求
 */
export function isApiRequest(url: string): boolean {
  return url.includes('/api/') || url.includes('/ws') || url.includes('/adapters/') || url.includes('/static/');
}

/**
 * 检查是否需要重定向
 */
export function needsRedirect(url: string): boolean {
  return (
    url.startsWith('app://') ||
    url.includes('index.html/') ||
    url.startsWith('ws://index.html') ||
    url.startsWith('http://index.html')
  );
}

/**
 * 重定向 API 请求 URL
 */
export function redirectApiUrl(url: string, port: string = '3000'): string {
  // WebSocket 请求使用 ws:// 协议
  if (url.includes('/ws') || url.startsWith('ws://')) {
    // 处理 ws://index.html/ws 或 app://index.html/ws
    // 提取路径和查询参数
    const pathMatch = url.match(/(\/ws[^?]*)(\?.*)?/);
    if (pathMatch) {
      return `ws://localhost:${port}${pathMatch[1]}${pathMatch[2] || ''}`;
    } else {
      return `ws://localhost:${port}/ws`;
    }
  } else {
    // HTTP 请求使用 http:// 协议
    // 处理 http://index.html/api 或 app://index.html/api
    // 也处理 /static/ 路径（插件静态资源由后端服务器提供）
    // 提取路径和查询参数
    const pathMatch = url.match(/(\/api\/[^?]*|\/adapters\/[^?]*|\/static\/[^?]*)(\?.*)?/);
    if (pathMatch) {
      return `http://localhost:${port}${pathMatch[1]}${pathMatch[2] || ''}`;
    } else {
      // 如果没有匹配到路径，尝试直接替换 hostname
      return url.replace(/^(http|app):\/\/[^/]*/, `http://localhost:${port}`);
    }
  }
}
