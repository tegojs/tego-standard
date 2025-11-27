#!/usr/bin/env node

/**
 * tego wrapper 脚本
 * 在启动 tego 前，将 PLUGIN_PATHS 环境变量解析为数组并设置到 globals
 * 因为 tego 期望 PLUGIN_PATHS 是数组，但环境变量只能是字符串
 */

// 设置 NODE_PATH 以确保能找到模块
// wrapper 脚本在 backend/scripts/ 目录，需要找到 backend/node_modules 中的模块
const path = require('path');
const fs = require('fs');

// 获取 backend 目录（wrapper 脚本在 backend/scripts/tego-wrapper.js）
const backendDir = path.resolve(__dirname, '..');

// 查找 node_modules 目录
const nodeModulesPath = path.join(backendDir, 'node_modules');
if (fs.existsSync(nodeModulesPath)) {
  // 将 node_modules 路径添加到 NODE_PATH
  const currentNodePath = process.env.NODE_PATH || '';
  const nodePaths = currentNodePath ? currentNodePath.split(path.delimiter) : [];
  if (!nodePaths.includes(nodeModulesPath)) {
    nodePaths.unshift(nodeModulesPath);
    process.env.NODE_PATH = nodePaths.join(path.delimiter);
  }
}

// 将 packages/@tachybase 目录添加到 NODE_PATH，这样 Node.js 的 require 才能找到插件
// 因为 tego 通过 PLUGIN_PATHS 找到 package.json，但 require 需要从 NODE_PATH 加载模块
// require('@tachybase/plugin-name') 会在 NODE_PATH 中查找 @tachybase/plugin-name
// 所以我们需要将 packages/@tachybase 的父目录（packages）添加到 NODE_PATH
const packagesPath = path.join(backendDir, 'packages');
const tachybasePluginsPath = path.join(packagesPath, '@tachybase');
if (fs.existsSync(packagesPath)) {
  const currentNodePath = process.env.NODE_PATH || '';
  const nodePaths = currentNodePath ? currentNodePath.split(path.delimiter) : [];

  // 添加 packages 目录（这样 require('@tachybase/plugin-name') 会在 packages/@tachybase/plugin-name 中查找）
  if (!nodePaths.includes(packagesPath)) {
    nodePaths.push(packagesPath);
    console.log(`[Tego Wrapper] Added packages to NODE_PATH: ${packagesPath}`);
  }

  // 如果 @tachybase 目录存在，也直接添加到 NODE_PATH（双重保险）
  if (fs.existsSync(tachybasePluginsPath)) {
    if (!nodePaths.includes(tachybasePluginsPath)) {
      nodePaths.push(tachybasePluginsPath);
      console.log(`[Tego Wrapper] Added @tachybase plugins directory to NODE_PATH: ${tachybasePluginsPath}`);
    }
  }

  process.env.NODE_PATH = nodePaths.join(path.delimiter);
  console.log(`[Tego Wrapper] Final NODE_PATH: ${process.env.NODE_PATH}`);
  console.log(`[Tego Wrapper] Node.js require('@tachybase/plugin-name') will search in:`);
  console.log(`[Tego Wrapper]   - ${packagesPath}/@tachybase/plugin-name`);
  if (fs.existsSync(tachybasePluginsPath)) {
    console.log(`[Tego Wrapper]   - ${tachybasePluginsPath}/plugin-name`);
  }

  // 安装模块解析 hook，拦截所有 @tachybase/* 的 require 请求
  // 这可以确保即使在 pnpm isolated 模式下或符号链接路径下也能找到模块
  const Module = require('module');
  const originalResolveFilename = Module._resolveFilename;

  // 在闭包中保存路径变量，确保在 hook 中可用
  const hookNodeModulesPath = nodeModulesPath;
  const hookPackagesPath = packagesPath;
  const hookTachybasePluginsPath = tachybasePluginsPath;
  const hookPnpmDir = path.join(hookNodeModulesPath, '.pnpm');

  Module._resolveFilename = function (request, parent, isMain, options) {
    // 如果是 @tachybase/* 模块，尝试从多个位置解析
    if (request.startsWith('@tachybase/')) {
      const moduleName = request.replace('@tachybase/', '');

      // 优先级 1: 从 node_modules 中查找（用于 globals 等非插件模块）
      // 在 pnpm 的 .pnpm 目录中查找
      // 使用绝对路径，确保无论从哪个路径加载都能找到
      const absolutePnpmDir = path.resolve(hookPnpmDir);
      if (fs.existsSync(absolutePnpmDir)) {
        try {
          const entries = fs.readdirSync(absolutePnpmDir);
          const moduleEntry = entries.find((entry) => {
            // 匹配 @tachybase+moduleName@* 格式
            return entry.startsWith(`@tachybase+${moduleName}@`);
          });

          if (moduleEntry) {
            const modulePath = path.resolve(absolutePnpmDir, moduleEntry, 'node_modules', '@tachybase', moduleName);
            if (fs.existsSync(modulePath)) {
              const packageJsonPath = path.join(modulePath, 'package.json');
              if (fs.existsSync(packageJsonPath)) {
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
                      console.log(`[Tego Wrapper] ✓ Resolved ${request} to ${absoluteMainPath} (from node_modules)`);
                      return absoluteMainPath;
                    }
                  }
                } catch (err) {
                  // 继续尝试其他路径
                }
              }
            }
          }
        } catch (err) {
          // 继续尝试其他路径
        }
      }

      // 优先级 2: 从 packages/@tachybase/ 目录查找（用于插件）
      if (moduleName.startsWith('plugin-')) {
        // 使用绝对路径，确保无论从哪个路径加载都能找到
        const absoluteTachybasePluginsPath = path.resolve(hookTachybasePluginsPath);
        const absolutePackagesPath = path.resolve(hookPackagesPath);

        const possiblePaths = [
          path.join(absoluteTachybasePluginsPath, moduleName),
          path.join(absolutePackagesPath, '@tachybase', moduleName),
          path.join(absolutePackagesPath, moduleName), // 直接路径（如果符号链接不存在）
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
                ];

                for (const mainPath of possibleMainFiles) {
                  const absoluteMainPath = path.resolve(mainPath);
                  if (fs.existsSync(absoluteMainPath)) {
                    console.log(`[Tego Wrapper] ✓ Resolved ${request} to ${absoluteMainPath} (from packages)`);
                    return absoluteMainPath;
                  }
                }
              } catch (err) {
                // 继续尝试其他路径
              }
            }
          }
        }
      }
    }

    // 对于其他模块，使用原始解析逻辑
    try {
      return originalResolveFilename.call(this, request, parent, isMain, options);
    } catch (err) {
      // 如果原始解析也失败，且是 @tachybase/* 模块，提供更详细的错误信息
      if (request.startsWith('@tachybase/')) {
        const parentPath = parent ? parent.filename || parent.id || 'unknown' : 'unknown';
        console.error(`[Tego Wrapper] ✗ Failed to resolve ${request} via original resolver`);
        console.error(`[Tego Wrapper] Parent: ${parentPath}`);
        console.error(`[Tego Wrapper] Error: ${err.message}`);
        console.error(`[Tego Wrapper] Available paths:`);
        console.error(`[Tego Wrapper]   - node_modules: ${hookNodeModulesPath}`);
        console.error(`[Tego Wrapper]   - packages: ${hookPackagesPath}`);
        console.error(`[Tego Wrapper]   - @tachybase: ${hookTachybasePluginsPath}`);
        console.error(`[Tego Wrapper]   - .pnpm: ${hookPnpmDir}`);
      }
      throw err;
    }
  };

  console.log(`[Tego Wrapper] Installed module resolution hook for @tachybase/* modules`);
}

// 必须在 require tego 之前设置 globals
// 使用更可靠的方法来查找模块（支持 pnpm 的 .pnpm 结构）
let TachybaseGlobal;

// 输出调试信息
console.log(`[Tego Wrapper] Starting module resolution...`);
console.log(`[Tego Wrapper] Backend dir: ${backendDir}`);
console.log(`[Tego Wrapper] Node modules path: ${nodeModulesPath}`);
console.log(`[Tego Wrapper] Node modules exists: ${fs.existsSync(nodeModulesPath)}`);
console.log(`[Tego Wrapper] NODE_PATH: ${process.env.NODE_PATH || '(not set)'}`);

// 首先尝试在 pnpm 的 .pnpm 目录中查找（这是最可靠的方法，因为 pnpm 使用 isolated 模式）
const pnpmDir = path.join(nodeModulesPath, '.pnpm');
if (fs.existsSync(pnpmDir)) {
  try {
    // 查找 @tachybase+globals@* 目录
    const entries = fs.readdirSync(pnpmDir);
    const globalsEntry = entries.find((entry) => entry.startsWith('@tachybase+globals@'));
    if (globalsEntry) {
      const globalsPath = path.join(pnpmDir, globalsEntry, 'node_modules', '@tachybase', 'globals');
      console.log(`[Tego Wrapper] Trying globals path: ${globalsPath}`);
      if (fs.existsSync(globalsPath)) {
        const packageJsonPath = path.join(globalsPath, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          // 直接使用绝对路径 require（最可靠的方法）
          // 注意：模块可能使用 default export，需要处理
          const globalsModule = require(globalsPath);
          TachybaseGlobal = globalsModule.default || globalsModule;
          console.log(`[Tego Wrapper] ✓ Found @tachybase/globals at: ${globalsPath}`);
        } else {
          console.error(`[Tego Wrapper] ✗ Error: package.json not found at: ${packageJsonPath}`);
        }
      } else {
        console.error(`[Tego Wrapper] ✗ Error: Globals path does not exist: ${globalsPath}`);
      }
    } else {
      console.error(`[Tego Wrapper] ✗ Error: Could not find @tachybase+globals@* in .pnpm directory`);
      console.error(`[Tego Wrapper] Available entries (first 20): ${entries.slice(0, 20).join(', ')}...`);
      const globalsEntries = entries.filter((e) => e.includes('globals'));
      if (globalsEntries.length > 0) {
        console.error(`[Tego Wrapper] Entries containing 'globals': ${globalsEntries.join(', ')}`);
      }
    }
  } catch (err) {
    console.error(`[Tego Wrapper] ✗ Error searching .pnpm directory: ${err.message}`);
    console.error(`[Tego Wrapper] Error stack: ${err.stack}`);
  }
} else {
  console.error(`[Tego Wrapper] ✗ Error: .pnpm directory does not exist: ${pnpmDir}`);
}

// 如果还没有找到，尝试直接 require（可能在某些配置下有效）
if (!TachybaseGlobal) {
  try {
    console.log(`[Tego Wrapper] Trying direct require('@tachybase/globals')...`);
    const globalsModule = require('@tachybase/globals');
    TachybaseGlobal = globalsModule.default || globalsModule;
    console.log(`[Tego Wrapper] ✓ Found @tachybase/globals via direct require`);
  } catch (err) {
    console.error(`[Tego Wrapper] ✗ Direct require failed: ${err.message}`);
    // 最后尝试使用 require.resolve（在 pnpm isolated 模式下通常无效）
    try {
      console.log(`[Tego Wrapper] Trying require.resolve with paths: ${nodeModulesPath}, ${backendDir}`);
      const globalsPath = require.resolve('@tachybase/globals', { paths: [nodeModulesPath, backendDir] });
      const globalsModule = require(globalsPath);
      TachybaseGlobal = globalsModule.default || globalsModule;
      console.log(`[Tego Wrapper] ✓ Found @tachybase/globals via require.resolve: ${globalsPath}`);
    } catch (resolveErr) {
      console.error(`[Tego Wrapper] ✗ Error: Cannot find @tachybase/globals module`);
      console.error(`[Tego Wrapper] Backend dir: ${backendDir}`);
      console.error(`[Tego Wrapper] Node modules path: ${nodeModulesPath}`);
      console.error(`[Tego Wrapper] Node modules exists: ${fs.existsSync(nodeModulesPath)}`);
      console.error(`[Tego Wrapper] .pnpm dir exists: ${fs.existsSync(pnpmDir)}`);
      if (fs.existsSync(pnpmDir)) {
        const entries = fs.readdirSync(pnpmDir);
        console.error(`[Tego Wrapper] .pnpm entries count: ${entries.length}`);
        const globalsEntries = entries.filter((e) => e.includes('globals'));
        console.error(`[Tego Wrapper] Entries containing 'globals': ${globalsEntries.join(', ')}`);
      }
      console.error(`[Tego Wrapper] Original error: ${resolveErr.message}`);
      console.error(`[Tego Wrapper] Error stack: ${resolveErr.stack}`);
      throw resolveErr;
    }
  }
}

// 验证模块是否成功加载
if (!TachybaseGlobal) {
  console.error(`[Tego Wrapper] ✗ Fatal: TachybaseGlobal is still undefined after all attempts`);
  process.exit(1);
}

// 从环境变量获取 PLUGIN_PATHS
const pluginPathsEnv = process.env.PLUGIN_PATHS;

if (pluginPathsEnv) {
  let pluginPaths;

  // 尝试解析为 JSON（如果设置了 JSON 格式）
  try {
    pluginPaths = JSON.parse(pluginPathsEnv);
    if (!Array.isArray(pluginPaths)) {
      // 如果不是数组，尝试按分隔符分割
      const separator = process.platform === 'win32' ? ';' : ':';
      pluginPaths = pluginPathsEnv.split(separator).filter(Boolean);
    }
  } catch (e) {
    // 如果不是 JSON，按分隔符分割
    const separator = process.platform === 'win32' ? ';' : ':';
    pluginPaths = pluginPathsEnv.split(separator).filter(Boolean);
  }

  // 设置到 globals（必须在 getInstance 之前设置）
  // 注意：我们需要在 initData 中设置，而不是在 getInstance 之后
  // 因为 getInstance 会使用 initData 初始化
  const initData = {
    PLUGIN_PATHS: pluginPaths,
  };
  const globals = TachybaseGlobal.getInstance(initData);

  console.log(`[Tego Wrapper] Set PLUGIN_PATHS as array with ${pluginPaths.length} path(s):`);
  pluginPaths.forEach((path, index) => {
    console.log(`[Tego Wrapper]   ${index + 1}. ${path}`);
  });
}

// 获取 tego 路径和参数
// process.argv[0] = node
// process.argv[1] = tego-wrapper.js
// process.argv[2] = tego.js 路径
// process.argv[3+] = tego 的参数（如 'start'）

const tegoPath = process.argv[2];
const tegoArgs = process.argv.slice(3);

if (!tegoPath) {
  console.error('[Tego Wrapper] Error: tego path not provided');
  process.exit(1);
}

// 修改 process.argv，让 tego 认为它是直接启动的
// 保留 node 和 tego.js 路径，移除 wrapper 脚本路径
process.argv = [process.argv[0], tegoPath, ...tegoArgs];

// 使用 require 加载 tego（这会执行 tego 的代码）
// tego.js 会读取 process.argv 来处理命令行参数
require(tegoPath);
