import * as http from 'node:http';

/**
 * 检查后端服务器是否运行
 */
export async function checkBackendServer(port: number = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      `http://localhost:${port}/`,
      {
        timeout: 2000,
      },
      (res: http.IncomingMessage) => {
        res.on('data', () => {});
        res.on('end', () => {
          req.destroy();
          resolve(true);
        });
      },
    );

    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}
