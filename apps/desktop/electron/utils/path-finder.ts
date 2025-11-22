import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

/**
 * 查找项目根目录
 * 在打包后的应用中，项目根目录可能在应用包附近，或者通过环境变量指定
 */
export function findProjectRoot(): string | null {
  // 方法1: 通过环境变量
  if (process.env.PROJECT_ROOT) {
    return process.env.PROJECT_ROOT;
  }

  // 方法2: 尝试从应用路径推断
  const appPath = app.getAppPath();

  // 如果是打包后的应用，appPath 可能是 app.asar
  if (appPath.includes('app.asar')) {
    // 尝试找到项目根目录（可能在 Resources 的上级目录）
    const resourcesPath = process.resourcesPath;
    const appBundlePath = path.dirname(path.dirname(resourcesPath)); // .app/Contents
    const possibleRoots = [
      path.join(appBundlePath, '..', '..'), // 从 .app 向上找两级
      path.join(resourcesPath, '..', '..', '..'), // 从 Resources 向上找
      path.dirname(resourcesPath),
      path.join(process.env.HOME || '', 'Projects', 'tegojs', 'tego-standard'), // 常见项目路径
      path.join(process.env.HOME || '', 'Projects', 'workProject', 'tegojs', 'tego-standard'), // 用户的项目路径
    ];

    for (const possibleRoot of possibleRoots) {
      const packageJsonPath = path.join(possibleRoot, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          if (packageJson.name === 'tachybase' && packageJson.scripts && packageJson.scripts['dev-server']) {
            return possibleRoot;
          }
        } catch (e) {
          // 忽略错误
        }
      }
    }
  } else {
    // 开发环境或未打包的应用
    // 从 apps/desktop 向上找到项目根目录
    return path.resolve(__dirname, '..', '..', '..');
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
