import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { log } from './logger';

/**
 * 查找项目根目录
 * 在打包后的应用中，项目根目录可能在应用包附近，或者通过环境变量指定
 */
export function findProjectRoot(): string | null {
  // 方法1: 通过环境变量
  if (process.env.PROJECT_ROOT) {
    log(`[PathFinder] Using PROJECT_ROOT from environment: ${process.env.PROJECT_ROOT}`);
    if (fs.existsSync(process.env.PROJECT_ROOT)) {
      return process.env.PROJECT_ROOT;
    }
    log(`[PathFinder] ⚠ PROJECT_ROOT path does not exist: ${process.env.PROJECT_ROOT}`, 'warn');
  }

  // 方法2: 尝试从应用路径推断
  const appPath = app.getAppPath();
  log(`[PathFinder] App path: ${appPath}`);
  log(`[PathFinder] Resources path: ${process.resourcesPath}`);
  log(`[PathFinder] Working directory: ${process.cwd()}`);
  log(`[PathFinder] Is packaged: ${app.isPackaged}`);

  // 如果是打包后的应用，appPath 可能是 app.asar
  if (appPath.includes('app.asar') || app.isPackaged) {
    log(`[PathFinder] Packaged app detected, searching for project root...`);
    // 尝试找到项目根目录（可能在 Resources 的上级目录）
    const resourcesPath = process.resourcesPath;
    const appBundlePath = path.dirname(path.dirname(resourcesPath)); // .app/Contents
    const appDir = path.dirname(appBundlePath); // .app 目录

    // 构建可能的项目根目录路径列表
    const possibleRoots: string[] = [];

    // 从应用包向上查找
    possibleRoots.push(
      path.join(appDir, '..'), // .app 的父目录
      path.join(appDir, '..', '..'), // .app 的上级目录
      path.join(appBundlePath, '..', '..'), // 从 Contents 向上找两级
      path.join(resourcesPath, '..', '..', '..'), // 从 Resources 向上找
      path.dirname(resourcesPath),
    );

    // 从当前工作目录向上查找（最多向上 5 级）
    const cwd = process.cwd();
    possibleRoots.push(cwd);
    let currentDir = cwd;
    for (let i = 0; i < 5; i++) {
      currentDir = path.dirname(currentDir);
      if (currentDir === path.dirname(currentDir)) {
        // 到达根目录，停止
        break;
      }
      possibleRoots.push(currentDir);
    }

    // 常见项目路径
    if (process.env.HOME) {
      possibleRoots.push(
        path.join(process.env.HOME, 'Projects', 'tegojs', 'tego-standard'),
        path.join(process.env.HOME, 'Projects', 'workProject', 'tegojs', 'tego-standard'),
      );
    }

    log(`[PathFinder] Checking ${possibleRoots.length} possible paths...`);
    for (const possibleRoot of possibleRoots) {
      const normalizedRoot = path.resolve(possibleRoot);
      const packageJsonPath = path.join(normalizedRoot, 'package.json');
      log(`[PathFinder] Checking: ${normalizedRoot}`);

      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          // 检查项目名称和 start 脚本（生产环境使用 tego start）
          if (packageJson.name === 'tachybase' && packageJson.scripts && packageJson.scripts['start']) {
            log(`[PathFinder] ✓ Found project root: ${normalizedRoot}`);
            return normalizedRoot;
          } else {
            log(
              `[PathFinder] Package.json found but doesn't match (name: ${packageJson.name}, has start: ${!!(packageJson.scripts && packageJson.scripts['start'])})`,
            );
          }
        } catch (e: any) {
          log(`[PathFinder] Error reading package.json: ${e.message}`);
        }
      }
    }

    log(`[PathFinder] ⚠ Could not find project root in any of the checked paths`, 'warn');
  } else {
    // 开发环境或未打包的应用
    // 从 apps/desktop 向上找到项目根目录
    const devRoot = path.resolve(__dirname, '..', '..', '..');
    log(`[PathFinder] Development mode, using: ${devRoot}`);
    return devRoot;
  }

  return null;
}

/**
 * 查找 web-dist 目录
 */
export function findWebDistPath(): string | null {
  // 注意：由于 asarUnpack 配置，web-dist 会被解包到 app.asar.unpacked 目录
  // 在 macOS 打包后的应用中，路径优先级：
  // 1. process.resourcesPath/app.asar.unpacked/web-dist (解包后的资源)
  // 2. process.resourcesPath/web-dist (如果直接放在 Resources 中)
  // 3. 开发环境的相对路径
  const possibleWebDistPaths = [
    // 优先检查解包后的路径（生产环境，asarUnpack 解包）
    path.join(process.resourcesPath, 'app.asar.unpacked', 'web-dist'),
    // 检查直接放在 Resources 中的路径（如果 asarUnpack 未生效）
    path.join(process.resourcesPath, 'web-dist'),
    // 开发环境路径
    path.join(__dirname, '..', 'web-dist'),
    path.join(app.getAppPath(), 'web-dist'),
    // 其他可能的路径
    path.join(process.resourcesPath, 'app.asar', 'web-dist'),
    path.join(app.getAppPath(), '..', 'web-dist'),
    path.join(process.resourcesPath, '..', 'web-dist'),
  ];

  log(`[PathFinder] Searching for web-dist directory...`);
  log(`[PathFinder] process.resourcesPath: ${process.resourcesPath}`);
  log(`[PathFinder] app.getAppPath(): ${app.getAppPath()}`);
  log(`[PathFinder] __dirname: ${__dirname}`);

  for (const possiblePath of possibleWebDistPaths) {
    const normalizedPath = path.resolve(possiblePath);
    log(`[PathFinder] Checking: ${normalizedPath}`);
    if (fs.existsSync(normalizedPath)) {
      const indexHtmlPath = path.join(normalizedPath, 'index.html');
      if (fs.existsSync(indexHtmlPath)) {
        log(`[PathFinder] ✓ Found web-dist at: ${normalizedPath}`);
        // 验证 assets 目录是否存在
        const assetsPath = path.join(normalizedPath, 'assets');
        if (fs.existsSync(assetsPath)) {
          const assetsCount = fs.readdirSync(assetsPath).length;
          log(`[PathFinder] ✓ Assets directory exists with ${assetsCount} files`);
        } else {
          log(`[PathFinder] ⚠ Assets directory not found at: ${assetsPath}`, 'warn');
        }
        return normalizedPath;
      } else {
        log(`[PathFinder] Directory exists but index.html not found: ${indexHtmlPath}`);
      }
    }
  }

  log(`[PathFinder] ⚠ Could not find web-dist directory in any of the checked paths`, 'warn');
  // 列出 Resources 目录内容以便调试
  try {
    if (fs.existsSync(process.resourcesPath)) {
      const resourcesContents = fs.readdirSync(process.resourcesPath);
      log(`[PathFinder] Resources directory contents: ${resourcesContents.join(', ')}`, 'error');
    }
  } catch (e) {
    log(`[PathFinder] Could not read Resources directory: ${e}`, 'error');
  }
  return null;
}

/**
 * 查找 web-dist/index.html 文件
 */
export function findWebDistIndexHtml(): string | null {
  const possiblePaths = [
    path.join(process.resourcesPath, 'web-dist', 'index.html'),
    path.join(__dirname, '..', 'web-dist', 'index.html'),
    path.join(app.getAppPath(), 'web-dist', 'index.html'),
  ];

  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      return possiblePath;
    }
  }

  return null;
}

/**
 * 获取用户目录下的 .tachybase-desktop 配置目录路径
 * 如果目录不存在，会自动创建
 */
export function getUserConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    throw new Error('Cannot determine user home directory');
  }

  const userConfigDir = path.join(home, '.tachybase-desktop');

  // 确保目录存在
  if (!fs.existsSync(userConfigDir)) {
    log(`[PathFinder] Creating user config directory: ${userConfigDir}`);
    fs.mkdirSync(userConfigDir, { recursive: true });
  }

  return userConfigDir;
}

/**
 * 获取用户目录下的 .env 文件路径
 */
export function getUserEnvPath(): string {
  return path.join(getUserConfigDir(), '.env');
}

/**
 * 获取用户目录下的数据库文件路径
 */
export function getUserDatabasePath(): string {
  const userConfigDir = getUserConfigDir();
  const dbDir = path.join(userConfigDir, 'db');

  // 确保数据库目录存在
  if (!fs.existsSync(dbDir)) {
    log(`[PathFinder] Creating database directory: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  return path.join(dbDir, 'tachybase.sqlite');
}

/**
 * 获取 Electron 应用的版本号
 * 优先从 app.getVersion() 获取，如果不可用则从 package.json 读取
 */
export function getElectronAppVersion(): string {
  try {
    // 优先使用 Electron 的 app.getVersion()（打包后的应用会使用这个）
    if (app && typeof app.getVersion === 'function') {
      const version = app.getVersion();
      if (version && version !== '0.0.0') {
        return version;
      }
    }
  } catch (error) {
    // 忽略错误，继续尝试其他方法
  }

  try {
    // 如果 app.getVersion() 不可用，从 apps/desktop/package.json 读取
    const desktopPackageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    if (fs.existsSync(desktopPackageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(desktopPackageJsonPath, 'utf8'));
      if (packageJson.version) {
        return packageJson.version;
      }
    }
  } catch (error: any) {
    log(`[PathFinder] ⚠ Failed to read Electron app version: ${error.message}`, 'warn');
  }

  return '1.0.0'; // 默认版本
}

/**
 * 初始化用户配置目录结构
 * 在应用首次启动或安装后调用，创建必要的目录和配置文件
 */
export function initializeUserConfig(): void {
  try {
    const userConfigDir = getUserConfigDir();
    const userEnvPath = getUserEnvPath();
    const userDatabasePath = getUserDatabasePath();
    const logsDir = path.join(userConfigDir, 'logs');

    log(`[PathFinder] Initializing user config directory: ${userConfigDir}`);

    // 确保所有必要的目录存在
    const dbDir = path.dirname(userDatabasePath);
    if (!fs.existsSync(dbDir)) {
      log(`[PathFinder] Creating database directory: ${dbDir}`);
      fs.mkdirSync(dbDir, { recursive: true });
    }

    if (!fs.existsSync(logsDir)) {
      log(`[PathFinder] Creating logs directory: ${logsDir}`);
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // 如果 .env 文件不存在，从应用包内或项目根目录的 .env.example 创建默认配置
    if (!fs.existsSync(userEnvPath)) {
      log(`[PathFinder] .env file not found, creating default configuration...`);

      let envExamplePath: string | null = null;

      // 如果是打包后的应用，必须从应用包内读取 .env.example
      if (app.isPackaged) {
        const resourcesPath = process.resourcesPath;
        const bundledEnvExample = path.join(resourcesPath, 'backend', '.env.example');
        if (fs.existsSync(bundledEnvExample)) {
          envExamplePath = bundledEnvExample;
          log(`[PathFinder] Found .env.example in app bundle`);
        } else {
          throw new Error(
            `.env.example not found in app bundle at ${bundledEnvExample}. The application was not packaged correctly.`,
          );
        }
      } else {
        // 开发环境：从项目根目录读取
        const projectRoot = findProjectRoot();
        if (projectRoot) {
          const projectEnvExample = path.join(projectRoot, '.env.example');
          if (fs.existsSync(projectEnvExample)) {
            envExamplePath = projectEnvExample;
            log(`[PathFinder] Found .env.example in project root`);
          } else {
            throw new Error(`.env.example not found in project root at ${projectEnvExample}.`);
          }
        } else {
          throw new Error(`Cannot find project root to load .env.example in development mode.`);
        }
      }

      if (!envExamplePath || !fs.existsSync(envExamplePath)) {
        throw new Error(`.env.example not found. Please ensure it exists.`);
      }

      let defaultEnvContent: string;
      try {
        defaultEnvContent = fs.readFileSync(envExamplePath, 'utf8');
        log(`[PathFinder] Loaded .env.example from: ${envExamplePath}`);
      } catch (error: any) {
        throw new Error(`Failed to read .env.example: ${error.message}`);
      }

      // 修改配置内容，将相对路径改为用户目录下的路径
      // 替换 DB_STORAGE 为相对路径（因为会在启动时转换为绝对路径）
      let modifiedContent = defaultEnvContent
        .replace(/DB_STORAGE=.*/g, `DB_STORAGE=db/tachybase.sqlite`)
        .replace(/LOGGER_BASE_PATH=.*/g, `LOGGER_BASE_PATH=logs`);

      // 写入用户目录下的 .env 文件
      fs.writeFileSync(userEnvPath, modifiedContent, 'utf8');
      log(`[PathFinder] ✓ Created default .env file at: ${userEnvPath}`);
    } else {
      log(`[PathFinder] .env file already exists: ${userEnvPath}`);
    }

    log(`[PathFinder] ✓ User config directory initialized successfully`);
    log(`[PathFinder]   - Config directory: ${userConfigDir}`);
    log(`[PathFinder]   - Database: ${userDatabasePath}`);
    log(`[PathFinder]   - Logs: ${logsDir}`);
    log(`[PathFinder]   - Env file: ${userEnvPath}`);
  } catch (error: any) {
    log(`[PathFinder] ⚠ Failed to initialize user config: ${error.message}`, 'error');
    log(`[PathFinder] Error stack: ${error.stack}`, 'error');
    throw error;
  }
}
