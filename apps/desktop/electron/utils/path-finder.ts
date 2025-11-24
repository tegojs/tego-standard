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
  const possibleWebDistPaths = [
    path.join(process.resourcesPath, 'web-dist'),
    path.join(__dirname, '..', 'web-dist'),
    path.join(app.getAppPath(), 'web-dist'),
  ];

  for (const possiblePath of possibleWebDistPaths) {
    if (fs.existsSync(possiblePath) && fs.existsSync(path.join(possiblePath, 'index.html'))) {
      return possiblePath;
    }
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
