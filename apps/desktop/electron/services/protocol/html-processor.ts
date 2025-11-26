/**
 * 处理 HTML 文件，修改静态资源路径
 */
export function processHtmlContent(htmlContent: string): string {
  const appPort = process.env.APP_PORT || '3000';

  // 将静态资源的绝对路径转换为 app:// 协议
  htmlContent = htmlContent.replace(
    /href="\/(assets\/[^"]+|global\.css|favicon\.ico|manifest\.webmanifest)"/g,
    'href="app://$1"',
  );
  htmlContent = htmlContent.replace(/src="\/(assets\/[^"]+|browser-checker\.js)"/g, 'src="app://$1"');

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
