#!/usr/bin/env node

/**
 * 检查开发所需端口是否被占用（Web 与后端 API）
 * 若被占用则退出并报错，避免 dev-server 启动失败而 Electron 仍误判「API 就绪」
 */

const net = require('net');

const webPort = parseInt(process.env.WEB_PORT || process.env.PORT || '31000', 10);
const appPort = parseInt(process.env.APP_PORT || '30000', 10);

function checkPortAvailable(portNumber, label) {
  return new Promise((resolve, reject) => {
    if (isNaN(portNumber)) {
      reject(new Error(`无效的端口号: ${portNumber}`));
      return;
    }
    const server = net.createServer();
    server.listen(portNumber, () => {
      server.once('close', () => resolve());
      server.close();
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `${label} 端口 ${portNumber} 已被占用。\n` +
              `   请先结束占用进程（例如旧 tego dev-server）：\n` +
              `   lsof -i :${portNumber} 或活动监视器中结束对应 Node 进程。\n` +
              `   也可改用其它端口：APP_PORT=30001 WEB_PORT=31001 pnpm dev`,
          ),
        );
      } else {
        reject(new Error(`检查 ${label} 端口时出错: ${err.message}`));
      }
    });
  });
}

async function main() {
  try {
    await checkPortAvailable(webPort, 'Web 开发服务器');
    console.log(`✅ Web 端口 ${webPort} 可用`);
    await checkPortAvailable(appPort, '后端 API (dev-server)');
    console.log(`✅ 后端 API 端口 ${appPort} 可用`);
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

main();
