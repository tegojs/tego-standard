import { ChildProcess, execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { app } from 'electron';

import { log } from '../utils/logger';
import {
  findProjectRoot,
  getElectronAppVersion,
  getUserConfigDir,
  getUserDatabasePath,
  getUserEnvPath,
} from '../utils/path-finder';

let serverProcess: ChildProcess | null = null;

/**
 * 检查后端服务器是否运行
 */
export async function checkBackendServer(port: number = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 尝试连接根路径，只要能建立连接就认为服务器在运行
    const req = http.get(
      `http://localhost:${port}/`,
      {
        timeout: 2000,
      },
      (res: http.IncomingMessage) => {
        // 任何状态码都表示服务器在运行（包括 200, 404, 500 等）
        // 但需要确保连接成功建立
        res.on('data', () => {}); // 消费响应数据
        res.on('end', () => {
          // 响应完成后销毁请求，释放 socket 连接
          req.destroy();
          resolve(true);
        });
      },
    );

    req.on('error', (error: NodeJS.ErrnoException) => {
      // 如果是连接被拒绝，明确返回 false
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        resolve(false);
      } else {
        // 其他错误也认为服务器不可用
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

  // 检查服务器是否已经在运行（多次检测以确保准确性）
  let isRunning = false;
  for (let i = 0; i < 3; i++) {
    isRunning = await checkBackendServer(port);
    if (isRunning) {
      break;
    }
    // 如果不是最后一次尝试，等待一下再重试
    if (i < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (isRunning) {
    log(`[Electron] Backend server is already running on port ${appPort}`);
    // 再次验证服务器真的能响应请求
    const verified = await checkBackendServer(port);
    if (!verified) {
      log(`[Electron] ⚠ Server detection was incorrect, will start new server`, 'warn');
      isRunning = false; // 强制启动新服务器
    } else {
      return;
    }
  }

  log(`[Electron] Starting backend server on port ${appPort}...`);

  // Node 查找优先级：
  // 1. 应用包中的 node（在构建时从系统复制到 Resources/node）- 最可靠
  // 2. 系统的 node（从 PATH 或常见路径查找）- 作为备选

  // 对于打包后的应用，必须使用应用包内的后端服务器资源
  // 后端服务器已打包到 Resources/backend 目录中

  let projectRoot: string | null = null;

  // 如果是打包后的应用，必须使用应用包内的后端服务器
  if (app.isPackaged) {
    // 应用包内的后端服务器路径
    const resourcesPath = process.resourcesPath;
    const backendPath = path.join(resourcesPath, 'backend');

    // 添加调试日志
    log(`[Electron] Checking backend server at: ${backendPath}`);
    log(`[Electron] Resources path: ${resourcesPath}`);
    log(`[Electron] Backend path exists: ${fs.existsSync(backendPath)}`);

    const packageJsonPath = path.join(backendPath, 'package.json');
    log(`[Electron] Package.json path: ${packageJsonPath}`);
    log(`[Electron] Package.json exists: ${fs.existsSync(packageJsonPath)}`);

    // 检查应用包内是否有后端服务器
    if (fs.existsSync(packageJsonPath)) {
      projectRoot = backendPath;
      log(`[Electron] Using bundled backend server at: ${projectRoot}`);
    } else {
      // 打包后的应用必须包含后端服务器，如果不存在则报错
      log(`[Electron] ✗ Bundled backend server not found at: ${backendPath}`, 'error');
      log(`[Electron] ✗ This is a packaged application, backend server must be bundled in the app.`, 'error');
      log(`[Electron] ✗ Please rebuild the application to include the backend server.`, 'error');
      // 列出 Resources 目录内容以便调试
      try {
        const resourcesContents = fs.existsSync(resourcesPath) ? fs.readdirSync(resourcesPath) : [];
        log(`[Electron] Resources directory contents: ${resourcesContents.slice(0, 20).join(', ')}`, 'error');
      } catch (e) {
        log(`[Electron] Could not read resources directory: ${e}`, 'error');
      }
      throw new Error(
        `Bundled backend server not found. The application was not packaged correctly. Please rebuild the application.`,
      );
    }
  } else {
    // 开发环境：使用项目根目录
    projectRoot = findProjectRoot();

    if (!projectRoot) {
      log(`[Electron] ⚠ Could not find project root directory. Backend server will not be started.`, 'error');
      log(`[Electron] In development mode, the project root directory must be accessible.`, 'error');
      log(
        `[Electron] Please ensure you are running from the project root or set PROJECT_ROOT environment variable.`,
        'error',
      );
      throw new Error(
        `Could not find project root directory. Please ensure the project root is accessible or set PROJECT_ROOT environment variable.`,
      );
    }
  }

  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    log(`[Electron] ⚠ Invalid backend server directory: ${projectRoot}`, 'error');
    throw new Error(`Invalid backend server directory: ${projectRoot}`);
  }

  log(`[Electron] Backend server directory: ${projectRoot}`);

  try {
    // 启动后端服务器
    const isWindows = process.platform === 'win32';

    // 在生产环境中，使用 tego start 或 node 运行 tego
    // 不依赖 pnpm（生产环境不需要包管理器）
    let args: string[] = [];
    let executablePath: string | null = null;
    let nodePathForEnv: string | null = null; // 保存 node 路径，用于设置 PATH

    // 方法1: 尝试使用 tego start（生产环境推荐）
    try {
      const tegoPath = execSync('command -v tego', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        shell: '/bin/bash',
      }).trim();
      if (tegoPath && fs.existsSync(tegoPath) && !tegoPath.includes('()')) {
        executablePath = tegoPath;
        args = ['start'];
        log(`[Electron] Using tego start: ${tegoPath}`);
      }
    } catch (error) {
      // tego 不可用，继续尝试其他方法
    }

    // 方法2: 如果 tego 不可用，尝试使用 node 直接运行 tego 的 JavaScript 入口文件
    if (!executablePath) {
      try {
        let nodePath: string | null = null;

        // 优先使用应用包中的 node（如果存在）
        // node 在构建时被复制到 Resources/node
        const bundledNodePath = path.join(process.resourcesPath, 'node');
        if (fs.existsSync(bundledNodePath)) {
          nodePath = bundledNodePath;
          log(`[Electron] Found bundled node at: ${nodePath}`);
        }

        // 如果应用包中没有 node，尝试从系统 PATH 查找
        if (!nodePath) {
          try {
            // 先尝试使用完整的 PATH（包含常见路径）
            const home = process.env.HOME || '';
            const searchPaths = [
              '/usr/local/bin',
              '/usr/bin',
              '/bin',
              '/opt/homebrew/bin',
              '/usr/local/opt/node/bin',
              path.join(home, '.local', 'bin'),
              path.join(home, '.npm-global', 'bin'),
            ].filter(Boolean);

            // 尝试从常见路径直接查找
            for (const searchPath of searchPaths) {
              const possibleNode = path.join(searchPath, 'node');
              if (fs.existsSync(possibleNode)) {
                nodePath = possibleNode;
                log(`[Electron] Found system node at: ${nodePath}`);
                break;
              }
            }

            // 如果还没找到，尝试查找 nvm 安装的 node 版本
            if (!nodePath && home) {
              const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
              if (fs.existsSync(nvmVersionsDir)) {
                try {
                  const versions = fs.readdirSync(nvmVersionsDir);
                  // 按版本号倒序排序，优先使用最新版本
                  const sortedVersions = versions.sort((a, b) => {
                    // 简单的版本比较（v20.19.5 > v20.18.0）
                    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
                  });
                  for (const version of sortedVersions) {
                    const versionNodePath = path.join(nvmVersionsDir, version, 'bin', 'node');
                    if (fs.existsSync(versionNodePath)) {
                      nodePath = versionNodePath;
                      log(`[Electron] Found nvm node at: ${nodePath}`);
                      break;
                    }
                  }
                } catch (e) {
                  log(`[Electron] Error reading nvm versions: ${e}`, 'warn');
                }
              }
              // 也尝试 nvm current/bin
              if (!nodePath) {
                const nvmCurrentBin = path.join(home, '.nvm', 'current', 'bin', 'node');
                if (fs.existsSync(nvmCurrentBin)) {
                  nodePath = nvmCurrentBin;
                  log(`[Electron] Found nvm current node at: ${nodePath}`);
                }
              }
            }

            // 如果还没找到，尝试使用 command -v（需要设置 PATH）
            if (!nodePath) {
              const envWithPath = {
                ...process.env,
                PATH: searchPaths.join(path.delimiter) + path.delimiter + (process.env.PATH || ''),
              };
              const foundNodePath = execSync('command -v node', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 5000,
                shell: '/bin/bash',
                env: envWithPath,
              }).trim();
              if (foundNodePath && fs.existsSync(foundNodePath) && !foundNodePath.includes('()')) {
                nodePath = foundNodePath;
                log(`[Electron] Found system node at: ${nodePath}`);
              }
            }
          } catch (error) {
            // 继续尝试其他方法
          }
        }

        if (!nodePath) {
          throw new Error('Node.js not found');
        }

        nodePathForEnv = nodePath; // 保存 node 路径
        executablePath = nodePath;

        // 直接运行 tego 的 JavaScript 入口文件，而不是 shell 脚本
        // tego 脚本最终会执行: node node_modules/tego/bin/tego.js start
        // 优先查找 tego.js，因为直接运行可以避免 shell 脚本的路径解析问题
        const tegoJsPath = path.join(projectRoot, 'node_modules', 'tego', 'bin', 'tego.js');

        // 如果 tego.js 不存在，也检查 .pnpm 目录（pnpm isolated 模式）
        let actualTegoJsPath = tegoJsPath;
        if (!fs.existsSync(tegoJsPath)) {
          // 检查 .pnpm 目录
          const pnpmPath = path.join(projectRoot, 'node_modules', '.pnpm');
          if (fs.existsSync(pnpmPath)) {
            try {
              const pnpmEntries = fs.readdirSync(pnpmPath);
              for (const entry of pnpmEntries) {
                if (entry.startsWith('tego@')) {
                  const tegoPnpmPath = path.join(pnpmPath, entry, 'node_modules', 'tego', 'bin', 'tego.js');
                  if (fs.existsSync(tegoPnpmPath)) {
                    actualTegoJsPath = tegoPnpmPath;
                    log(`[Electron] Found tego.js in .pnpm directory: ${actualTegoJsPath}`);
                    break;
                  }
                }
              }
            } catch (err) {
              log(`[Electron] Error searching .pnpm directory: ${err}`, 'warn');
            }
          }
        }

        if (fs.existsSync(actualTegoJsPath)) {
          args = [actualTegoJsPath, 'start'];
          log(`[Electron] Using node to run tego.js: ${nodePath} ${actualTegoJsPath} start`);
        } else {
          // 如果找不到 tego.js，尝试查找 .bin/tego 脚本（作为备选）
          // 但需要设置正确的工作目录和 PATH，以确保脚本能正确解析模块路径
          const tegoBinPath = path.join(projectRoot, 'node_modules', '.bin', 'tego');
          if (fs.existsSync(tegoBinPath)) {
            // tego 是一个 shell 脚本，需要用 shell 来执行
            // 但脚本内部会调用 node，所以需要确保 PATH 中包含 node
            // 同时需要确保工作目录正确，以便脚本能正确解析模块路径
            nodePathForEnv = nodePath; // 保存 node 路径，用于设置 PATH
            executablePath = '/bin/sh';
            args = [tegoBinPath, 'start'];
            log(`[Electron] Using shell to run tego script: /bin/sh ${tegoBinPath} start`);
            log(`[Electron] Node path for PATH: ${nodePath}`);
            log(`[Electron] Working directory will be: ${projectRoot}`);
          } else {
            const errorMsg =
              'Could not find tego executable. Please ensure the backend server dependencies are installed.';
            log(`[Electron] ⚠ ${errorMsg}`, 'error');
            log(`[Electron] Expected tego.js at: ${tegoJsPath}`, 'error');
            log(`[Electron] Expected tego script at: ${tegoBinPath}`, 'error');
            throw new Error(errorMsg);
          }
        }
      } catch (error: any) {
        const errorMsg =
          'Could not find tego or node executable. Please ensure Node.js and backend server dependencies are installed.';
        log(`[Electron] ⚠ ${errorMsg}`, 'error');
        if (error.message) {
          log(`[Electron] Error details: ${error.message}`, 'error');
        }
        throw new Error(errorMsg);
      }
    }

    if (!executablePath) {
      const errorMsg = 'Could not find executable to start backend server.';
      log(`[Electron] ⚠ ${errorMsg}`, 'error');
      throw new Error(errorMsg);
    }

    // 确保 PATH 环境变量包含常见路径（特别是通过 Finder 启动时）
    // 通过 Finder 启动时，PATH 可能不完整，需要手动添加常见路径
    const home = process.env.HOME || '';
    const defaultPaths = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin', // Apple Silicon Mac
      '/usr/local/opt/node/bin', // Homebrew Node.js
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
    ];

    // 确保 node 的目录在 PATH 的最前面
    // 这对于 shell 脚本内部使用 `exec node` 非常重要
    if (nodePathForEnv) {
      const nodeDir = path.dirname(nodePathForEnv);
      // 确保 node 的目录在 PATH 的最前面
      const nodeDirIndex = defaultPaths.indexOf(nodeDir);
      if (nodeDirIndex !== -1) {
        // 如果已存在，先移除
        defaultPaths.splice(nodeDirIndex, 1);
      }
      defaultPaths.unshift(nodeDir); // 添加到最前面，确保优先使用
      log(`[Electron] Node directory added to PATH: ${nodeDir}`);
    } else if (executablePath && executablePath.includes('node')) {
      // 如果没有保存 nodePathForEnv，但 executablePath 是 node，也添加到 PATH
      const nodeDir = path.dirname(executablePath);
      const nodeDirIndex = defaultPaths.indexOf(nodeDir);
      if (nodeDirIndex !== -1) {
        defaultPaths.splice(nodeDirIndex, 1);
      }
      defaultPaths.unshift(nodeDir);
      log(`[Electron] Node directory added to PATH: ${nodeDir}`);
    }

    // 添加 nvm 路径（如果存在）
    if (home && !isWindows) {
      // 查找所有 nvm 安装的 node 版本
      const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmVersionsDir)) {
        try {
          const versions = fs.readdirSync(nvmVersionsDir);
          for (const version of versions) {
            const versionBinPath = path.join(nvmVersionsDir, version, 'bin');
            if (fs.existsSync(versionBinPath) && !defaultPaths.includes(versionBinPath)) {
              defaultPaths.push(versionBinPath);
            }
          }
        } catch (e) {
          // 忽略错误
        }
      }
      // 添加 nvm current/bin 路径
      const nvmCurrentBin = path.join(home, '.nvm', 'current', 'bin');
      if (fs.existsSync(nvmCurrentBin) && !defaultPaths.includes(nvmCurrentBin)) {
        defaultPaths.push(nvmCurrentBin);
      }
    }

    const existingPath = process.env.PATH || '';
    const pathArray = existingPath.split(path.delimiter).filter(Boolean);
    const combinedPaths = [...new Set([...pathArray, ...defaultPaths])]; // 去重

    // 获取用户目录下的配置路径
    let userConfigDir: string;
    let userDatabasePath: string;
    let userEnvPath: string;
    try {
      userConfigDir = getUserConfigDir();
      userDatabasePath = getUserDatabasePath();
      userEnvPath = getUserEnvPath();
      log(`[Electron] User config directory: ${userConfigDir}`);
      log(`[Electron] User database path: ${userDatabasePath}`);
      log(`[Electron] User env path: ${userEnvPath}`);
    } catch (error: any) {
      log(`[Electron] ⚠ Failed to get user config directory: ${error.message}`, 'error');
      log(`[Electron] Will use project root configuration instead`, 'warn');
      userConfigDir = '';
      userDatabasePath = '';
      userEnvPath = '';
    }

    // 获取 Electron 应用版本
    const electronAppVersion = getElectronAppVersion();
    log(`[Electron] Electron app version: ${electronAppVersion}`);

    // 构建环境变量，优先使用用户目录下的配置
    const env: Record<string, string> = {
      ...process.env,
      APP_PORT: appPort,
      NODE_ENV: 'production',
      PATH: combinedPaths.join(path.delimiter),
      // 传递 Electron 应用版本给后端服务器
      ELECTRON_APP_VERSION: electronAppVersion,
    };

    // 如果用户目录下有 .env 文件，先读取并合并到环境变量中
    if (userEnvPath && fs.existsSync(userEnvPath)) {
      log(`[Electron] Found user .env file: ${userEnvPath}`);
      // 读取用户 .env 文件并合并到环境变量中
      try {
        const envContent = fs.readFileSync(userEnvPath, 'utf8');
        const envLines = envContent.split('\n');
        for (const line of envLines) {
          const trimmedLine = line.trim();
          // 跳过注释和空行
          if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
          }
          // 解析 KEY=VALUE 格式
          const equalIndex = trimmedLine.indexOf('=');
          if (equalIndex > 0) {
            const key = trimmedLine.substring(0, equalIndex).trim();
            const value = trimmedLine.substring(equalIndex + 1).trim();
            // 移除引号（如果有）
            const cleanValue = value.replace(/^["']|["']$/g, '');
            // 如果环境变量中还没有设置，则使用 .env 文件中的值
            if (key && !process.env[key]) {
              env[key] = cleanValue;
            }
          }
        }
        log(`[Electron] Loaded environment variables from user .env file`);
      } catch (error: any) {
        log(`[Electron] ⚠ Failed to read user .env file: ${error.message}`, 'warn');
      }
    } else {
      log(`[Electron] User .env file not found, using default configuration`);
    }

    // 强制设置数据库路径为用户目录下的路径（覆盖 .env 文件中的设置）
    if (userDatabasePath) {
      env.DB_STORAGE = userDatabasePath;
      env.DB_DIALECT = 'sqlite';
      log(`[Electron] Using user database: ${userDatabasePath}`);
    }

    // 如果设置了日志路径，将其转换为用户目录下的绝对路径
    if (userConfigDir) {
      if (env.LOGGER_BASE_PATH) {
        // 如果是相对路径，转换为用户目录下的绝对路径
        if (!path.isAbsolute(env.LOGGER_BASE_PATH)) {
          env.LOGGER_BASE_PATH = path.join(userConfigDir, env.LOGGER_BASE_PATH);
          log(`[Electron] Using user logs directory: ${env.LOGGER_BASE_PATH}`);
        }
      } else {
        // 如果没有设置日志路径，使用用户目录下的默认路径
        env.LOGGER_BASE_PATH = path.join(userConfigDir, 'logs');
        log(`[Electron] Using default user logs directory: ${env.LOGGER_BASE_PATH}`);
      }
    }

    log(`[Electron] Starting backend server with PATH: ${env.PATH.substring(0, 200)}...`);
    log(`[Electron] Using executable: ${executablePath}`);
    log(`[Electron] Args: ${args.join(' ')}`);
    log(`[Electron] Working directory: ${projectRoot}`);

    serverProcess = spawn(executablePath, args, {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 确保在 macOS 上通过 Finder 启动时也能正确执行
      shell: false,
    });

    // 记录服务器输出（保存监听器引用以便清理）
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

    // 等待服务器启动
    try {
      await waitForServerStart(parseInt(appPort, 10), serverProcess);

      // 启动成功后，添加持续监听器用于记录进程退出日志
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
      // 如果等待服务器启动失败，移除监听器并清理
      if (serverProcess) {
        serverProcess.stdout?.removeAllListeners('data');
        serverProcess.stderr?.removeAllListeners('data');
        serverProcess = null;
      }
      throw waitError;
    }
  } catch (error: any) {
    log(`[Electron] Error starting backend server: ${error.message}`, 'error');
    // 在异常情况下确保清理
    if (serverProcess) {
      // 如果监听器已经添加，尝试移除（可能在某些错误情况下监听器还未添加）
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
 * 等待服务器启动
 */
async function waitForServerStart(port: number, process: ChildProcess): Promise<void> {
  log(`[Electron] Waiting for backend server to start...`);
  let retries = 60; // 最多等待 60 秒
  let processExited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  // 监听进程退出事件（使用 once() 防止内存泄漏，只在启动期间监听）
  const exitHandler = (code: number | null, signal: string | null) => {
    processExited = true;
    exitCode = code;
    exitSignal = signal;
    log(`[Electron] Backend server process exited with code ${code}, signal ${signal}`);
    serverProcess = null;
  };
  process.once('exit', exitHandler);

  const errorHandler = (error: Error) => {
    log(`[Electron] Failed to start backend server: ${error.message}`, 'error');
    processExited = true;
    serverProcess = null;
  };
  process.once('error', errorHandler);

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
      // 启动成功后，移除启动期间的监听器（使用 once() 已自动移除）
      // 持续监听进程退出由 startBackendServer 中的全局监听器处理
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
