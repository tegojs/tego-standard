#!/usr/bin/env node

/**
 * 检查端口是否被占用
 * 如果被占用，退出并报错
 */

const net = require('net');

const port = process.env.WEB_PORT || process.env.PORT || '31000';
const portNumber = parseInt(port, 10);

if (isNaN(portNumber)) {
  console.error(`❌ 无效的端口号: ${port}`);
  process.exit(1);
}

const server = net.createServer();

server.listen(portNumber, () => {
  server.once('close', () => {
    console.log(`✅ 端口 ${portNumber} 可用`);
    process.exit(0);
  });
  server.close();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${portNumber} 已被占用，请先释放该端口或使用其他端口`);
    console.error(`   提示: 可以通过 WEB_PORT 环境变量指定其他端口，例如: WEB_PORT=3000 pnpm desktop:dev`);
    process.exit(1);
  } else {
    console.error(`❌ 检查端口时出错: ${err.message}`);
    process.exit(1);
  }
});
