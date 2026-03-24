import * as http from 'node:http';

import { getAppPortNumber } from '../../utils/config';

/** 与首屏 LocalePlugin 请求一致，避免根路径 200 但 API 仍 503（旧进程 / maintaining）时误判就绪 */
const API_READY_PATH = process.env.DESKTOP_API_READY_PATH || '/api/app:getLang?locale=en-US';

/**
 * 检查后端是否已可正常提供 API（而非仅端口上有进程）
 * - 2xx / 304：可服务
 * - 503（含 maintaining）：仍在启动或不可用
 * - 其它：视为未就绪，避免把非本应用的监听进程当成后端
 */
export async function checkBackendServer(port: number = getAppPortNumber()): Promise<boolean> {
  const path = API_READY_PATH.startsWith('/') ? API_READY_PATH : `/${API_READY_PATH}`;
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}${path}`,
      {
        timeout: 5000,
        headers: {
          'X-Role': 'anonymous',
        },
      },
      (res: http.IncomingMessage) => {
        const statusCode = res.statusCode || 0;
        if (statusCode >= 200 && statusCode < 300) {
          res.resume();
          resolve(true);
          return;
        }
        if (statusCode === 304) {
          res.resume();
          resolve(true);
          return;
        }

        res.resume();
        res.on('end', () => {
          req.destroy();
          resolve(false);
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

    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
  });
}
