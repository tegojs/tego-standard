import { getAppPort } from '../../utils/config';

/**
 * 处理 HTML 文件，修改静态资源路径
 */
export function processHtmlContent(htmlContent: string): string {
  const appPort = getAppPort();

  // 将静态资源的绝对路径转换为 app:// 协议
  // 匹配 href="/assets/..." 或 href="/global.css" 等格式
  htmlContent = htmlContent.replace(
    /href="\/(assets\/[^"]+|global\.css|favicon\.ico|manifest\.webmanifest)"/g,
    'href="app://$1"',
  );
  // 匹配 src="/assets/..." 或 src="/browser-checker.js" 等格式
  htmlContent = htmlContent.replace(/src="\/(assets\/[^"]+|browser-checker\.js)"/g, 'src="app://$1"');

  // 处理已经使用 app:// 协议但路径不正确的格式（如 app:///assets/... 三个斜杠）
  htmlContent = htmlContent.replace(/(href|src)="app:\/\/\/([^"]+)"/g, '$1="app://$2"');

  // 处理 /static/ 路径（插件静态资源）
  htmlContent = htmlContent.replace(/(href|src)="\/static\/([^"]+)"/g, '$1="app://static/$2"');

  // 注入 WebSocket URL 配置
  const wsConfigScript = `
    <script>
      (function() {
        if (window.location.protocol === 'app:') {
          window.__tachybase_ws_url__ = 'ws://localhost:${appPort}';
          window.__tachybase_api_base_url__ = window.__tachybase_api_base_url__ || 'http://localhost:${appPort}/api/';
        }
      })();
    </script>
  `;

  if (htmlContent.includes('</head>')) {
    htmlContent = htmlContent.replace('</head>', `${wsConfigScript}</head>`);
  } else if (htmlContent.includes('<body')) {
    htmlContent = htmlContent.replace('<body', `${wsConfigScript}<body`);
  } else {
    htmlContent = wsConfigScript + htmlContent;
  }

  return htmlContent;
}
