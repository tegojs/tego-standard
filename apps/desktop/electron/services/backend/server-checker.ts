import * as http from 'node:http';

import { getAppPortNumber } from '../../utils/config';

/**
 * 检查后端服务器是否运行
 * 注意：即使 HTTP 连接成功，后端可能还在加载插件（maintaining 状态）
 * 我们需要检查响应状态码，如果返回 503 且包含 maintaining，说明后端还在启动中
 */
export async function checkBackendServer(port: number = getAppPortNumber()): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      `http://localhost:${port}/`,
      {
        timeout: 3000,
      },
      (res: http.IncomingMessage) => {
        // 检查状态码
        // 200-299: 服务器正常运行
        // 503: 服务器在维护中（可能还在加载插件）
        // 其他: 服务器可能有问题，但我们认为服务器进程在运行
        const statusCode = res.statusCode || 0;
        let responseData = '';

        res.on('data', (chunk: Buffer) => {
          responseData += chunk.toString();
        });

        res.on('end', () => {
          req.destroy();
          // 如果返回 503 且包含 maintaining，说明后端还在启动中
          if (statusCode === 503 && responseData.includes('maintaining')) {
            // 服务器还在启动中，返回 false 让前端继续等待
            resolve(false);
          } else if (statusCode >= 200 && statusCode < 500) {
            // 服务器已启动并可以响应请求
            resolve(true);
          } else {
            // 其他情况，认为服务器在运行但可能有问题
            resolve(true);
          }
        });
      },
    );

    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        resolve(false);
      } else {
        // 其他错误（如网络错误），也认为服务器不可用
        resolve(false);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}
