#!/usr/bin/env node

/**
 * tego-wrapper 辅助工具函数
 * 提供模块解析相关的工具函数
 */

const path = require('path');
const fs = require('fs');

/**
 * 路径配置对象
 * @typedef {Object} PathConfig
 * @property {string} nodeModulesPath - node_modules 目录路径
 * @property {string} packagesPath - packages 目录路径
 * @property {string} tachybasePluginsPath - @tachybase 插件目录路径
 * @property {string} pnpmDir - .pnpm 目录路径
 */

/**
 * 从 pnpm 的 .pnpm 目录中查找模块路径
 * @param {string} baseModuleName - 基础模块名（如 'client', 'module-acl'）
 * @param {string} pnpmDir - .pnpm 目录路径
 * @returns {string|null} 模块路径，如果未找到则返回 null
 */
function findModuleInPnpm(baseModuleName, pnpmDir) {
  const absolutePnpmDir = path.resolve(pnpmDir);
  if (!fs.existsSync(absolutePnpmDir)) {
    return null;
  }

  try {
    const entries = fs.readdirSync(absolutePnpmDir);
    const moduleEntry = entries.find((entry) => {
      return entry.startsWith(`@tachybase+${baseModuleName}@`);
    });

    if (moduleEntry) {
      const modulePath = path.resolve(absolutePnpmDir, moduleEntry, 'node_modules', '@tachybase', baseModuleName);
      if (fs.existsSync(modulePath)) {
        return modulePath;
      }
    }
  } catch (err) {
    // 继续尝试其他路径
  }

  return null;
}

/**
 * 从 packages 目录中查找模块路径
 * @param {string} baseModuleName - 基础模块名
 * @param {string} packagesPath - packages 目录路径
 * @param {string} tachybasePluginsPath - @tachybase 插件目录路径
 * @returns {string|null} 模块路径，如果未找到则返回 null
 */
function findModuleInPackages(baseModuleName, packagesPath, tachybasePluginsPath) {
  const absoluteTachybasePluginsPath = path.resolve(tachybasePluginsPath);
  const absolutePackagesPath = path.resolve(packagesPath);

  const possiblePaths = [
    path.join(absolutePackagesPath, baseModuleName),
    path.join(absoluteTachybasePluginsPath, baseModuleName),
    path.join(absolutePackagesPath, '@tachybase', baseModuleName),
  ];

  for (const modulePath of possiblePaths) {
    const absoluteModulePath = path.resolve(modulePath);
    if (fs.existsSync(absoluteModulePath)) {
      return absoluteModulePath;
    }
  }

  return null;
}

/**
 * 解析基础模块路径
 * @param {string} baseModuleName - 基础模块名（如 'client', 'module-acl', 'plugin-auth-lark'）
 * @param {PathConfig} paths - 路径配置对象
 * @returns {string|null} 模块路径，如果未找到则返回 null
 */
function resolveBaseModule(baseModuleName, paths) {
  // 优先级 1: 从 node_modules 中查找（用于 globals、client 等非插件模块）
  const modulePathFromPnpm = findModuleInPnpm(baseModuleName, paths.pnpmDir);
  if (modulePathFromPnpm) {
    return modulePathFromPnpm;
  }

  // 优先级 2: 从 packages/ 目录查找（用于 module-* 和 plugin-* 模块，以及 client 等）
  const modulePathFromPackages = findModuleInPackages(baseModuleName, paths.packagesPath, paths.tachybasePluginsPath);
  if (modulePathFromPackages) {
    return modulePathFromPackages;
  }

  return null;
}

/**
 * 生成可能的子路径列表（处理 src -> lib/dist 的转换）
 * @param {string} baseModulePath - 基础模块路径
 * @param {string} subPath - 子路径（如 'src/locale/en-US' 或 'src'）
 * @returns {string[]} 可能的子路径列表
 */
function generatePossibleSubPaths(baseModulePath, subPath) {
  const possibleSubPaths = [];

  // 如果子路径以 src/ 开头，尝试替换为 lib/ 或 dist/
  if (subPath.startsWith('src/')) {
    const restPath = subPath.substring(4); // 移除 'src/'
    possibleSubPaths.push(
      path.join(baseModulePath, 'lib', restPath), // 打包后通常在 lib/
      path.join(baseModulePath, 'dist', restPath), // 某些模块在 dist/
      path.join(baseModulePath, 'src', restPath), // 开发环境可能在 src/
    );
  } else if (subPath.startsWith('dist/')) {
    const restPath = subPath.substring(5); // 移除 'dist/'
    possibleSubPaths.push(
      path.join(baseModulePath, 'dist', restPath),
      path.join(baseModulePath, 'lib', restPath), // 某些模块可能使用 lib/
    );
  } else if (subPath === 'src') {
    // @tachybase/client/src -> @tachybase/client/lib
    possibleSubPaths.push(
      path.join(baseModulePath, 'lib'),
      path.join(baseModulePath, 'dist'),
      path.join(baseModulePath, 'src'),
    );
  } else if (subPath === 'dist') {
    possibleSubPaths.push(path.join(baseModulePath, 'dist'), path.join(baseModulePath, 'lib'));
  } else {
    // 其他子路径，直接拼接
    possibleSubPaths.push(
      path.join(baseModulePath, subPath),
      path.join(baseModulePath, 'lib', subPath),
      path.join(baseModulePath, 'dist', subPath),
    );
  }

  return possibleSubPaths;
}

/**
 * 解析子路径（如 @tachybase/client/src 或 @tachybase/module-acl/src/locale/en-US）
 * @param {string} baseModulePath - 基础模块路径
 * @param {string} subPath - 子路径
 * @returns {string|null} 解析后的文件路径，如果未找到则返回 null
 */
function resolveSubPath(baseModulePath, subPath) {
  const possibleSubPaths = generatePossibleSubPaths(baseModulePath, subPath);

  // Node.js 支持的扩展名（按优先级排序）
  const extensions = ['', '.js', '.json', '.node'];

  // 尝试每个可能的路径
  for (const subPathToTry of possibleSubPaths) {
    const absoluteSubPath = path.resolve(subPathToTry);

    // 首先尝试直接路径（可能是文件或目录）
    if (fs.existsSync(absoluteSubPath)) {
      const stats = fs.statSync(absoluteSubPath);
      // 如果是文件，直接返回
      if (stats.isFile()) {
        return absoluteSubPath;
      }
      // 如果是目录，尝试查找 index 文件
      if (stats.isDirectory()) {
        const indexFiles = [path.join(absoluteSubPath, 'index.js'), path.join(absoluteSubPath, 'index.json')];
        for (const indexFile of indexFiles) {
          if (fs.existsSync(indexFile)) {
            return indexFile;
          }
        }
      }
    }

    // 如果直接路径不存在，尝试添加扩展名（用于 locale 文件等）
    // 例如：@tachybase/module-acl/src/locale/en-US -> .../dist/locale/en-US.json
    for (const ext of extensions) {
      if (ext === '') continue; // 已经尝试过了
      const pathWithExt = absoluteSubPath + ext;
      if (fs.existsSync(pathWithExt) && fs.statSync(pathWithExt).isFile()) {
        return pathWithExt;
      }
    }
  }

  return null;
}

/**
 * 从 pnpm 目录解析模块的主入口文件
 * @param {string} moduleName - 完整模块名（如 'module-acl'）
 * @param {string} pnpmDir - .pnpm 目录路径
 * @returns {string|null} 主入口文件路径，如果未找到则返回 null
 */
function resolveModuleMainFromPnpm(moduleName, pnpmDir) {
  const modulePath = findModuleInPnpm(moduleName, pnpmDir);
  if (!modulePath) {
    return null;
  }

  const packageJsonPath = path.join(modulePath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    let mainFile = pkgJson.main || 'index.js';
    if (!path.isAbsolute(mainFile)) {
      mainFile = path.join(modulePath, mainFile);
    }

    const possibleMainFiles = [
      mainFile,
      path.join(modulePath, 'index.js'),
      path.join(modulePath, 'src', 'index.js'),
      path.join(modulePath, 'lib', 'index.js'),
      path.join(modulePath, 'dist', 'index.js'),
    ];

    for (const mainPath of possibleMainFiles) {
      const absoluteMainPath = path.resolve(mainPath);
      if (fs.existsSync(absoluteMainPath)) {
        return absoluteMainPath;
      }
    }
  } catch (err) {
    // 继续尝试其他路径
  }

  return null;
}

/**
 * 从 packages 目录解析模块的主入口文件
 * @param {string} moduleName - 完整模块名（如 'module-acl'）
 * @param {string} packagesPath - packages 目录路径
 * @param {string} tachybasePluginsPath - @tachybase 插件目录路径
 * @returns {string|null} 主入口文件路径，如果未找到则返回 null
 */
function resolveModuleMainFromPackages(moduleName, packagesPath, tachybasePluginsPath) {
  const absoluteTachybasePluginsPath = path.resolve(tachybasePluginsPath);
  const absolutePackagesPath = path.resolve(packagesPath);

  const possiblePaths = [
    path.join(absolutePackagesPath, moduleName), // 最可能的路径（实际位置）
    path.join(absoluteTachybasePluginsPath, moduleName),
    path.join(absolutePackagesPath, '@tachybase', moduleName),
  ];

  for (const modulePath of possiblePaths) {
    const absoluteModulePath = path.resolve(modulePath);
    if (fs.existsSync(absoluteModulePath)) {
      const packageJsonPath = path.join(absoluteModulePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          let mainFile = pkgJson.main || 'index.js';
          if (!path.isAbsolute(mainFile)) {
            mainFile = path.join(absoluteModulePath, mainFile);
          }

          const possibleMainFiles = [
            mainFile,
            path.join(absoluteModulePath, 'index.js'),
            path.join(absoluteModulePath, 'src', 'index.js'),
            path.join(absoluteModulePath, 'lib', 'index.js'),
            path.join(absoluteModulePath, 'dist', 'index.js'),
            path.join(absoluteModulePath, 'dist', 'server', 'index.js'), // 某些模块的入口在 dist/server/index.js
          ];

          for (const mainPath of possibleMainFiles) {
            const absoluteMainPath = path.resolve(mainPath);
            if (fs.existsSync(absoluteMainPath)) {
              return absoluteMainPath;
            }
          }
        } catch (err) {
          // 继续尝试其他路径
        }
      }
    }
  }

  return null;
}

/**
 * 查找 @tachybase/globals 模块
 * @param {string} nodeModulesPath - node_modules 目录路径
 * @returns {Object|null} 返回 { module, path }，如果未找到则返回 null
 */
function findGlobalsModule(nodeModulesPath) {
  const pnpmDir = path.join(nodeModulesPath, '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    try {
      const entries = fs.readdirSync(pnpmDir);
      const globalsEntry = entries.find((entry) => entry.startsWith('@tachybase+globals@'));
      if (globalsEntry) {
        const globalsPath = path.join(pnpmDir, globalsEntry, 'node_modules', '@tachybase', 'globals');
        if (fs.existsSync(globalsPath)) {
          const packageJsonPath = path.join(globalsPath, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const globalsModule = require(globalsPath);
            return {
              module: globalsModule.default || globalsModule,
              path: globalsPath,
            };
          }
        }
      }
    } catch (err) {
      // 继续尝试其他方法
    }
  }

  return null;
}

module.exports = {
  resolveBaseModule,
  resolveSubPath,
  resolveModuleMainFromPnpm,
  resolveModuleMainFromPackages,
  findGlobalsModule,
  findModuleInPnpm,
  findModuleInPackages,
};
