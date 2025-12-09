import * as fs from 'node:fs';
import * as path from 'node:path';

import { getAppPort } from '../../utils/config';
import { log } from '../../utils/logger';
import { getElectronAppVersion, getUserConfigDir, getUserDatabasePath, getUserEnvPath } from '../../utils/path-finder';

/**
 * 构建环境变量配置
 */
export function buildEnvironmentVariables(
  nodePathForEnv: string | null,
  backendProjectRoot?: string,
): Record<string, string> {
  const appPort = getAppPort();
  const home = process.env.HOME || '';

  // 构建 PATH
  const defaultPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/node/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ];

  if (nodePathForEnv) {
    const nodeDir = path.dirname(nodePathForEnv);
    const nodeDirIndex = defaultPaths.indexOf(nodeDir);
    if (nodeDirIndex !== -1) {
      defaultPaths.splice(nodeDirIndex, 1);
    }
    defaultPaths.unshift(nodeDir);
    log(`[Electron] Node directory added to PATH: ${nodeDir}`);
  }

  // 添加 nvm 路径
  if (home) {
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
    const nvmCurrentBin = path.join(home, '.nvm', 'current', 'bin');
    if (fs.existsSync(nvmCurrentBin) && !defaultPaths.includes(nvmCurrentBin)) {
      defaultPaths.push(nvmCurrentBin);
    }
  }

  const existingPath = process.env.PATH || '';
  const pathArray = existingPath.split(path.delimiter).filter(Boolean);
  const combinedPaths = [...new Set([...pathArray, ...defaultPaths])];

  // 获取用户配置
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
    userConfigDir = '';
    userDatabasePath = '';
    userEnvPath = '';
  }

  const electronAppVersion = getElectronAppVersion();
  log(`[Electron] Electron app version: ${electronAppVersion}`);

  const env: Record<string, string> = {
    ...process.env,
    APP_PORT: appPort,
    NODE_ENV: 'production',
    PATH: combinedPaths.join(path.delimiter),
    ELECTRON_APP_VERSION: electronAppVersion,
  };

  // 读取用户 .env 文件
  if (userEnvPath && fs.existsSync(userEnvPath)) {
    log(`[Electron] Found user .env file: ${userEnvPath}`);
    try {
      const envContent = fs.readFileSync(userEnvPath, 'utf8');
      const envLines = envContent.split('\n');
      for (const line of envLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          continue;
        }
        const equalIndex = trimmedLine.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmedLine.substring(0, equalIndex).trim();
          const value = trimmedLine.substring(equalIndex + 1).trim();
          const cleanValue = value.replace(/^["']|["']$/g, '');
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

  // 设置数据库路径
  if (userDatabasePath) {
    env.DB_STORAGE = userDatabasePath;
    env.DB_DIALECT = 'sqlite';
    log(`[Electron] Using user database: ${userDatabasePath}`);
  }

  // 设置日志路径
  if (userConfigDir) {
    if (env.LOGGER_BASE_PATH) {
      if (!path.isAbsolute(env.LOGGER_BASE_PATH)) {
        env.LOGGER_BASE_PATH = path.join(userConfigDir, env.LOGGER_BASE_PATH);
        log(`[Electron] Using user logs directory: ${env.LOGGER_BASE_PATH}`);
      }
    } else {
      env.LOGGER_BASE_PATH = path.join(userConfigDir, 'logs');
      log(`[Electron] Using default user logs directory: ${env.LOGGER_BASE_PATH}`);
    }
  }

  // 设置 PLUGIN_PATHS，让 tego 能够从 packages 目录解析插件
  // 后端服务器的工作目录是 backend-temp（backendProjectRoot），packages 目录在其中
  // 注意：tego 期望的路径格式是 basePath/@tachybase/plugin-name/package.json
  // 但实际目录结构是 packages/plugin-name/package.json
  // 所以我们需要将 PLUGIN_PATHS 设置为 packages 目录，tego 会尝试查找 packages/@tachybase/plugin-name
  // 如果找不到，tego 应该会回退到其他查找方式（如 node_modules）
  const possiblePackagesPaths: string[] = [];

  if (backendProjectRoot) {
    // 优先使用后端项目根目录下的 packages
    possiblePackagesPaths.push(path.join(backendProjectRoot, 'packages'));
  }

  // 也尝试从当前工作目录查找（作为后备）
  possiblePackagesPaths.push(path.join(process.cwd(), 'packages'));

  let pluginPaths: string[] = [];
  for (const possiblePath of possiblePackagesPaths) {
    if (fs.existsSync(possiblePath)) {
      pluginPaths.push(possiblePath);
      log(`[Electron] Found packages directory: ${possiblePath}`);
      break;
    }
  }

  // 如果找到了 packages 目录，设置 PLUGIN_PATHS
  // 注意：tego 期望 PLUGIN_PATHS 是一个数组，但环境变量只能是字符串
  // 我们需要创建一个初始化脚本，在 tego 启动时解析环境变量为数组
  // 或者，我们可以通过 JSON 格式传递数组（但环境变量不支持复杂对象）
  // 解决方案：创建一个 wrapper 脚本，在启动 tego 前设置 globals
  // 但更简单的方法是：将 PLUGIN_PATHS 设置为 JSON 字符串，然后在 tego 启动脚本中解析
  // 或者，我们可以创建一个初始化文件，让 tego 读取
  // 暂时使用 JSON 字符串格式，tego 需要自己解析（如果支持的话）
  // 如果不支持，我们需要创建一个 wrapper 脚本
  if (pluginPaths.length > 0) {
    // tego 期望 PLUGIN_PATHS 是数组，但环境变量只能是字符串
    // 我们使用 JSON 格式，wrapper 脚本会解析为数组并设置到 globals
    env.PLUGIN_PATHS = JSON.stringify(pluginPaths);
    log(`[Electron] Set PLUGIN_PATHS (JSON): ${env.PLUGIN_PATHS}`);
    log(`[Electron] Note: tego wrapper will parse this and set as array in globals`);
    log(`[Electron] tego will look for plugins at: ${pluginPaths[0]}/@tachybase/plugin-name/package.json`);
    log(`[Electron] Actual path is: ${pluginPaths[0]}/plugin-name/package.json`);
  } else {
    log(`[Electron] ⚠ Packages directory not found, PLUGIN_PATHS not set`, 'warn');
    log(`[Electron] Checked paths: ${possiblePackagesPaths.join(', ')}`, 'warn');
  }

  // 设置 NODE_PATH，确保 worker thread 和其他子进程能够找到 @tachybase/* 模块
  // 这是 desktop 应用特定的配置，确保在打包环境中 worker thread 能正确解析模块
  // 虽然 tego-wrapper.js 也会设置 NODE_PATH，但在这里提前设置可以确保：
  // 1. Worker thread 启动时就能使用正确的 NODE_PATH
  // 2. 即使不使用 wrapper 脚本，NODE_PATH 也能正确设置
  // 3. 在打包环境中，使用绝对路径确保 worker thread 能找到模块（因为代码在 app.asar 内部，但 node_modules 在外部）
  if (backendProjectRoot) {
    // 使用绝对路径，确保在打包环境中也能正确解析
    // 在打包环境中，backendProjectRoot 是 Resources/backend
    // 在开发环境中，backendProjectRoot 是项目根目录
    const nodeModulesPath = path.resolve(backendProjectRoot, 'node_modules');
    const packagesPath = path.resolve(backendProjectRoot, 'packages');
    const tachybasePluginsPath = path.resolve(packagesPath, '@tachybase');

    const nodePaths: string[] = [];
    const existingNodePath = process.env.NODE_PATH || '';
    if (existingNodePath) {
      // 将现有路径也转换为绝对路径
      const existingPaths = existingNodePath.split(path.delimiter).filter(Boolean);
      for (const existingPath of existingPaths) {
        const absolutePath = path.isAbsolute(existingPath) ? existingPath : path.resolve(existingPath);
        if (!nodePaths.includes(absolutePath)) {
          nodePaths.push(absolutePath);
        }
      }
    }

    // 添加 node_modules 路径（用于查找 @tachybase/globals 等核心模块）
    // 使用绝对路径，优先级最高（放在最前面）
    // 这是最关键的路径，worker thread 需要通过它找到 @tachybase/globals
    if (fs.existsSync(nodeModulesPath)) {
      if (!nodePaths.includes(nodeModulesPath)) {
        nodePaths.unshift(nodeModulesPath);
        log(`[Electron] Added node_modules to NODE_PATH: ${nodeModulesPath}`);
      }

      // 验证关键模块是否存在（用于调试）
      const globalsPath = path.join(nodeModulesPath, '@tachybase', 'globals');
      if (fs.existsSync(globalsPath)) {
        log(`[Electron] ✓ Verified @tachybase/globals exists at: ${globalsPath}`);
      } else {
        log(`[Electron] ⚠ @tachybase/globals not found at: ${globalsPath}`, 'warn');
        // 检查是否是 pnpm 的 isolated 模式
        const pnpmDir = path.join(nodeModulesPath, '.pnpm');
        if (fs.existsSync(pnpmDir)) {
          log(`[Electron] Found .pnpm directory, using pnpm isolated mode`);
        }
      }
    } else {
      log(`[Electron] ⚠ node_modules directory not found at: ${nodeModulesPath}`, 'warn');
    }

    // 添加 packages 路径（用于查找插件）
    if (fs.existsSync(packagesPath) && !nodePaths.includes(packagesPath)) {
      nodePaths.push(packagesPath);
      log(`[Electron] Added packages to NODE_PATH: ${packagesPath}`);
    }

    // 添加 @tachybase 路径（双重保险）
    if (fs.existsSync(tachybasePluginsPath) && !nodePaths.includes(tachybasePluginsPath)) {
      nodePaths.push(tachybasePluginsPath);
      log(`[Electron] Added @tachybase plugins directory to NODE_PATH: ${tachybasePluginsPath}`);
    }

    if (nodePaths.length > 0) {
      env.NODE_PATH = nodePaths.join(path.delimiter);
      log(`[Electron] Set NODE_PATH (${nodePaths.length} paths): ${env.NODE_PATH}`);
    } else {
      log(`[Electron] ⚠ No valid paths found for NODE_PATH`, 'warn');
    }
  } else {
    log(`[Electron] ⚠ backendProjectRoot not provided, cannot set NODE_PATH`, 'warn');
  }

  return env;
}
