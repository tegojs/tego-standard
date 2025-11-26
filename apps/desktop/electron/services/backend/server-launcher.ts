import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { log } from '../../utils/logger';
import { findProjectRoot } from '../../utils/path-finder';
import { ensureApplicationInstalled } from './app-installer';
import { buildEnvironmentVariables } from './env-config';
import { findNodePath } from './node-finder';
import { checkBackendServer } from './server-checker';
import { waitForServerStart } from './server-waiter';
import { findTegoExecutable, findTegoJsPath } from './tego-finder';

// 导出给外部使用
export { checkBackendServer };

let serverProcess: ChildProcess | null = null;

/**
 * 查找项目根目录
 */
function findBackendProjectRoot(): string {
  if (app.isPackaged) {
    const resourcesPath = process.resourcesPath;
    const backendPath = path.join(resourcesPath, 'backend');

    log(`[Electron] Checking backend server at: ${backendPath}`);
    log(`[Electron] Resources path: ${resourcesPath}`);
    log(`[Electron] Backend path exists: ${fs.existsSync(backendPath)}`);

    const packageJsonPath = path.join(backendPath, 'package.json');
    log(`[Electron] Package.json path: ${packageJsonPath}`);
    log(`[Electron] Package.json exists: ${fs.existsSync(packageJsonPath)}`);

    if (fs.existsSync(packageJsonPath)) {
      log(`[Electron] Using bundled backend server at: ${backendPath}`);
      return backendPath;
    } else {
      log(`[Electron] ✗ Bundled backend server not found at: ${backendPath}`, 'error');
      log(`[Electron] ✗ This is a packaged application, backend server must be bundled in the app.`, 'error');
      throw new Error(
        `Bundled backend server not found. The application was not packaged correctly. Please rebuild the application.`,
      );
    }
  } else {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      throw new Error(
        `Could not find project root directory. Please ensure the project root is accessible or set PROJECT_ROOT environment variable.`,
      );
    }
    return projectRoot;
  }
}

/**
 * 准备启动参数
 */
function prepareStartupArgs(projectRoot: string): {
  executablePath: string;
  args: string[];
  nodePathForEnv: string | null;
} {
  const tegoExecutable = findTegoExecutable(projectRoot);
  if (tegoExecutable) {
    return {
      executablePath: tegoExecutable.executablePath,
      args: tegoExecutable.args,
      nodePathForEnv: null,
    };
  }

  const nodePath = findNodePath();
  if (!nodePath) {
    throw new Error('Could not find tego or node executable.');
  }

  const tegoJsPath = findTegoJsPath(projectRoot);
  if (!tegoJsPath) {
    const tegoBinPath = path.join(projectRoot, 'node_modules', '.bin', 'tego');
    if (fs.existsSync(tegoBinPath)) {
      return {
        executablePath: '/bin/sh',
        args: [tegoBinPath, 'start'],
        nodePathForEnv: nodePath,
      };
    }
    throw new Error('Could not find tego executable.');
  }

  return {
    executablePath: nodePath,
    args: [tegoJsPath, 'start'],
    nodePathForEnv: nodePath,
  };
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
  const port = parseInt(appPort, 10);

  // 检查服务器是否已经在运行
  let isRunning = false;
  for (let i = 0; i < 3; i++) {
    isRunning = await checkBackendServer(port);
    if (isRunning) {
      break;
    }
    if (i < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (isRunning) {
    log(`[Electron] Backend server is already running on port ${appPort}`);
    const verified = await checkBackendServer(port);
    if (!verified) {
      log(`[Electron] ⚠ Server detection was incorrect, will start new server`, 'warn');
      isRunning = false;
    } else {
      return;
    }
  }

  log(`[Electron] Starting backend server on port ${appPort}...`);

  const projectRoot = findBackendProjectRoot();

  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    log(`[Electron] ⚠ Invalid backend server directory: ${projectRoot}`, 'error');
    throw new Error(`Invalid backend server directory: ${projectRoot}`);
  }

  log(`[Electron] Backend server directory: ${projectRoot}`);

  try {
    const { executablePath, args, nodePathForEnv } = prepareStartupArgs(projectRoot);
    const env = buildEnvironmentVariables(nodePathForEnv);

    await ensureApplicationInstalled(projectRoot, executablePath, nodePathForEnv, env);

    log(`[Electron] Starting backend server with PATH: ${env.PATH.substring(0, 200)}...`);
    log(`[Electron] Using executable: ${executablePath}`);
    log(`[Electron] Args: ${args.join(' ')}`);
    log(`[Electron] Working directory: ${projectRoot}`);

    serverProcess = spawn(executablePath, args, {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const onStdoutData = (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        log(`[Backend Server] ${output}`);
      }
    };

    const onStderrData = (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        log(`[Backend Server] ${output}`, 'error');
      }
    };

    serverProcess.stdout?.on('data', onStdoutData);
    serverProcess.stderr?.on('data', onStderrData);

    try {
      await waitForServerStart(port, serverProcess);

      if (serverProcess) {
        serverProcess.once('exit', (code: number | null, signal: string | null) => {
          log(`[Electron] Backend server process exited with code ${code}, signal ${signal}`);
          serverProcess = null;
        });

        serverProcess.once('error', (error: Error) => {
          log(`[Electron] Backend server process error: ${error.message}`, 'error');
          serverProcess = null;
        });
      }
    } catch (waitError: any) {
      if (serverProcess) {
        serverProcess.stdout?.removeAllListeners('data');
        serverProcess.stderr?.removeAllListeners('data');
        serverProcess = null;
      }
      throw waitError;
    }
  } catch (error: any) {
    log(`[Electron] Error starting backend server: ${error.message}`, 'error');
    if (serverProcess) {
      try {
        serverProcess.stdout?.removeAllListeners('data');
        serverProcess.stderr?.removeAllListeners('data');
      } catch {
        // 忽略清理错误
      }
      serverProcess = null;
    }
    throw error;
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
