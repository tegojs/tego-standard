/**
 * 检查是否是 API 请求
 * 注意：/static/plugins/ 路径由插件模块处理逻辑单独处理，不在这里判断
 */
export function isApiRequest(url: string): boolean {
  return (
    url.includes('/api/') ||
    url.includes('/ws') ||
    url.includes('/adapters/') ||
    (url.includes('/static/') && !url.includes('/static/plugins/'))
  );
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
    let query = pathMatch?.[2] || '';

    // 修复查询参数中的 hostname
    if (query) {
      query = query
        .replace(/__hostname=index\.html/g, '__hostname=localhost')
        .replace(/hostname=index\.html/g, 'hostname=localhost');
    }

    if (pathMatch) {
      return `ws://localhost:${port}${pathMatch[1]}${query}`;
    } else {
      return `ws://localhost:${port}/ws${query}`;
    }
  } else {
    // HTTP 请求使用 http:// 协议
    // 处理 http://index.html/api 或 app://index.html/api
    // 也处理 /static/ 路径（插件静态资源由后端服务器提供）

    // 先移除 app:// 或 http:// 协议前缀，以及可能的 index.html/ hostname
    let cleanUrl = url.replace(/^(app|http):\/\/(index\.html\/)?/, '');

    // 确保路径以 / 开头
    if (!cleanUrl.startsWith('/')) {
      cleanUrl = '/' + cleanUrl;
    }

    // 提取路径和查询参数
    const pathMatch = cleanUrl.match(/(\/api\/[^?]*|\/adapters\/[^?]*|\/static\/[^?]*)(\?.*)?/);
    let query = pathMatch?.[2] || '';

    // 修复查询参数中的 hostname
    if (query) {
      query = query
        .replace(/__hostname=index\.html/g, '__hostname=localhost')
        .replace(/hostname=index\.html/g, 'hostname=localhost');
    }

    if (pathMatch) {
      return `http://localhost:${port}${pathMatch[1]}${query}`;
    } else {
      // 如果没有匹配到路径，尝试直接使用清理后的 URL
      const redirected = `http://localhost:${port}${cleanUrl}`;
      // 也修复查询参数
      return redirected.replace(/__hostname=index\.html/g, '__hostname=localhost');
    }
  }
}
