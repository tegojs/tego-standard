import * as fs from 'node:fs';
import * as path from 'node:path';

import { getAppPort } from '../../utils/config';
import { log } from '../../utils/logger';
import { getElectronAppVersion, getUserConfigDir, getUserDatabasePath, getUserEnvPath } from '../../utils/path-finder';

/**
 * 构建环境变量配置
 */
export function buildEnvironmentVariables(nodePathForEnv: string | null): Record<string, string> {
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

  return env;
}
