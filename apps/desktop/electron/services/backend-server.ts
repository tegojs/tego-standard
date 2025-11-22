import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { app } from 'electron';

import { log } from '../utils/logger';
import { findProjectRoot } from '../utils/path-finder';

let serverProcess: ChildProcess | null = null;

/**
 * 检查后端服务器是否运行
 */
export async function checkBackendServer(port: number = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 尝试连接根路径，只要能建立连接就认为服务器在运行
    const req = http.get(`http://localhost:${port}/`, (res: http.IncomingMessage) => {
      // 任何状态码都表示服务器在运行（包括 200, 404, 500 等）
      resolve(true);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 启动后端服务器
 */
export async function startBackendServer(): Promise<void> {
  if (serverProcess) {
    log('[Electron] Backend server process already exists', 'warn');
    return;
  }

  const appPort = process.env.APP_PORT || '3000';

  // 检查服务器是否已经在运行
  const isRunning = await checkBackendServer(parseInt(appPort, 10));
  if (isRunning) {
    log(`[Electron] Backend server is already running on port ${appPort}`);
    return;
  }

  log(`[Electron] Starting backend server on port ${appPort}...`);

  // 查找项目根目录
  const projectRoot = findProjectRoot();

  if (!projectRoot) {
    log(`[Electron] ⚠ Could not find project root directory. Backend server will not be started.`, 'warn');
    log(`[Electron] Please ensure the backend server is running on port ${appPort}`, 'warn');
    log(`[Electron] You can start it manually with: pnpm dev-server`, 'warn');
    return;
  }

  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    log(`[Electron] ⚠ Invalid project root directory: ${projectRoot}`, 'warn');
    return;
  }

  log(`[Electron] Project root: ${projectRoot}`);

  try {
    // 启动后端服务器
    // 使用 pnpm 启动 dev-server
    const isWindows = process.platform === 'win32';
    const pnpmCommand = isWindows ? 'pnpm.cmd' : 'pnpm';

    serverProcess = spawn(pnpmCommand, ['dev-server'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        APP_PORT: appPort,
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 记录服务器输出
    serverProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        log(`[Backend Server] ${output}`);
      }
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        log(`[Backend Server] ${output}`, 'error');
      }
    });

    // 等待服务器启动
    await waitForServerStart(parseInt(appPort, 10), serverProcess);
  } catch (error: any) {
    log(`[Electron] Error starting backend server: ${error.message}`, 'error');
    serverProcess = null;
    throw error;
  }
}

/**
 * 等待服务器启动
 */
async function waitForServerStart(port: number, process: ChildProcess): Promise<void> {
  log(`[Electron] Waiting for backend server to start...`);
  let retries = 60; // 最多等待 60 秒
  let processExited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  // 监听进程退出事件
  const exitHandler = (code: number | null, signal: string | null) => {
    processExited = true;
    exitCode = code;
    exitSignal = signal;
    log(`[Electron] Backend server process exited with code ${code}, signal ${signal}`);
    serverProcess = null;
  };
  process.on('exit', exitHandler);

  process.on('error', (error) => {
    log(`[Electron] Failed to start backend server: ${error.message}`, 'error');
    processExited = true;
    serverProcess = null;
  });

  while (retries > 0) {
    // 检查进程是否还在运行
    if (processExited || !process || process.killed) {
      const errorMsg =
        exitCode !== null
          ? `Backend server process exited with code ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''} before startup completed`
          : 'Backend server process exited unexpectedly before startup completed';
      log(`[Electron] ⚠ ${errorMsg}`, 'error');
      serverProcess = null;
      throw new Error(errorMsg);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    const isRunning = await checkBackendServer(port);
    if (isRunning) {
      log(`[Electron] ✓ Backend server started successfully on port ${port}`);
      // exitHandler 会继续监听进程退出，用于记录日志
      return;
    }

    retries--;
    if (retries % 10 === 0) {
      log(`[Electron] Still waiting for backend server... (${60 - retries}s elapsed)`);
    }
  }

  // 如果进程还在运行但没有响应，记录警告
  if (process && !process.killed) {
    log(`[Electron] ⚠ Backend server did not respond within 60 seconds, but process is still running`, 'warn');
    log(`[Electron] The server may still be starting up. Continuing anyway...`, 'warn');
  } else {
    log(`[Electron] ⚠ Backend server did not start within 60 seconds`, 'error');
    serverProcess = null;
    throw new Error('Backend server failed to start within timeout period');
  }
}

/**
 * 停止后端服务器
 */
export function stopBackendServer(): void {
  if (serverProcess) {
    log('[Electron] Stopping backend server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}
