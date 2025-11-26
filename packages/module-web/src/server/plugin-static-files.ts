import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Gateway, Plugin } from '@tego/server';

import express from 'express';

/**
 * 注册插件静态文件服务
 * 提供 /static/plugins/ 路径的静态文件服务
 */
export function registerPluginStaticFiles(plugin: Plugin): void {
  const callback = express();
  const prefix = '/static/plugins';

  // 构建包名到文件夹名的映射（处理 prototype 前缀等不一致情况）
  const packageNameToFolderMap = new Map<string, string>();

  const buildPackageNameMap = (packagesDir: string) => {
    if (!existsSync(packagesDir)) return;

    try {
      const folders = readdirSync(packagesDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const folder of folders) {
        const pkgJsonPath = join(packagesDir, folder, 'package.json');
        if (existsSync(pkgJsonPath)) {
          try {
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
            if (pkgJson.name && pkgJson.name.startsWith('@tachybase/')) {
              // 提取包名的简短形式（去掉 @tachybase/）
              const shortName = pkgJson.name.replace('@tachybase/', '');
              packageNameToFolderMap.set(shortName, folder);
            }
          } catch (e) {
            // 忽略无法解析的 package.json
          }
        }
      }
    } catch (e) {
      // 忽略读取目录失败的情况
    }
  };

  // 从多个可能的 packages 目录构建映射
  const possiblePackagesDirs = [
    join(process.cwd(), 'packages'),
    join(__dirname, '../../../../packages'),
    join(__dirname, '../../../packages'),
  ];

  for (const packagesDir of possiblePackagesDirs) {
    buildPackageNameMap(packagesDir);
  }

  // 调试日志：输出映射关系
  if (packageNameToFolderMap.size > 0) {
    const mappings = Array.from(packageNameToFolderMap.entries())
      .filter(([key, value]) => key !== value)
      .map(([key, value]) => `${key} -> ${value}`)
      .join(', ');
    if (mappings) {
      console.log('[plugin-static-files] Package name mappings:', mappings);
    }
  }

  // 尝试从多个可能的位置解析插件路径
  const getPluginBasePath = (): string | null => {
    // 方法1: 从 node_modules/@tachybase 目录（生产环境）
    // 优先使用 process.cwd()，因为后端服务器在项目根目录启动
    const nodeModulesPaths = [
      join(process.cwd(), 'node_modules', '@tachybase'),
      join(__dirname, '../../../../node_modules/@tachybase'),
      join(__dirname, '../../../node_modules/@tachybase'),
      // 尝试从编译后的文件位置推断
      join(__dirname, '../../../../../node_modules/@tachybase'),
    ];

    for (const nodeModulesPath of nodeModulesPaths) {
      if (existsSync(nodeModulesPath)) {
        // 验证是否有插件文件
        try {
          const files = require('node:fs').readdirSync(nodeModulesPath);
          const hasPlugins = files.some((file: string) => file.startsWith('plugin-'));
          if (hasPlugins) {
            return nodeModulesPath;
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // 方法2: 尝试通过 require.resolve 解析
    try {
      // 尝试解析一个已知的插件包
      const testPluginPath = require.resolve('@tachybase/plugin-otp/package.json');
      const pluginDir = dirname(testPluginPath);
      const tachybaseDir = dirname(pluginDir);
      if (existsSync(tachybaseDir)) {
        return tachybaseDir;
      }
    } catch (e) {
      // ignore
    }

    // 方法3: 从 packages 目录（开发环境）
    const packagesPaths = [
      join(process.cwd(), 'packages'),
      join(__dirname, '../../../../packages'),
      join(__dirname, '../../../packages'),
    ];

    for (const packagesPath of packagesPaths) {
      if (existsSync(packagesPath)) {
        // 检查是否有插件目录
        try {
          const files = require('node:fs').readdirSync(packagesPath);
          const hasPlugins = files.some((file: string) => file.startsWith('plugin-'));
          if (hasPlugins) {
            // 返回 packages 目录，但需要特殊处理路径映射
            return packagesPath;
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // 方法4: 从运行时环境变量
    if (process.env.TEGO_RUNTIME_HOME) {
      const runtimePluginsPath = join(process.env.TEGO_RUNTIME_HOME, 'node_modules', '@tachybase');
      if (existsSync(runtimePluginsPath)) {
        return runtimePluginsPath;
      }
    }

    return null;
  };

  // 根据插件名称查找实际文件路径（支持从多个位置查找，支持包名到文件夹名的映射）
  const findPluginFile = (pluginName: string, relativePath: string): string | null => {
    // 移除 @tachybase/ 前缀（如果有）
    const cleanPluginName = pluginName.replace(/^@tachybase\//, '');

    // 尝试使用映射找到真实的文件夹名
    const actualFolderName = packageNameToFolderMap.get(cleanPluginName) || cleanPluginName;

    // 可能的插件位置
    const possibleBasePaths = [
      join(process.cwd(), 'node_modules', '@tachybase', actualFolderName),
      join(process.cwd(), 'packages', actualFolderName),
      join(__dirname, '../../../../node_modules/@tachybase', actualFolderName),
      join(__dirname, '../../../../packages', actualFolderName),
      join(__dirname, '../../../node_modules/@tachybase', actualFolderName),
      join(__dirname, '../../../packages', actualFolderName),
    ];

    // 如果设置了 TEGO_RUNTIME_HOME，也检查那里
    if (process.env.TEGO_RUNTIME_HOME) {
      possibleBasePaths.push(join(process.env.TEGO_RUNTIME_HOME, 'node_modules', '@tachybase', actualFolderName));
    }

    for (const basePath of possibleBasePaths) {
      const filePath = join(basePath, relativePath);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return filePath;
      }
    }

    return null;
  };

  const pluginBasePath = getPluginBasePath();

  if (pluginBasePath) {
    // 判断是否从 packages 目录提供服务（开发环境）
    const isPackagesPath = pluginBasePath.includes('packages');

    // 统一处理插件文件请求（支持从多个位置查找）
    // 请求路径: /static/plugins/@tachybase/plugin-name/dist/client/index.js
    callback.use((req, res, next) => {
      // 解析请求路径
      const match = req.path.match(/^\/static\/plugins\/@tachybase\/([^/]+)\/(.+)$/);

      if (!match) {
        // 路径不匹配，继续下一个中间件
        return next();
      }

      const [, pluginName, relativePath] = match;

      // 使用映射找到真实的文件夹名
      const cleanPluginName = pluginName.replace('@tachybase/', '');
      const actualFolderName = packageNameToFolderMap.get(cleanPluginName) || cleanPluginName;

      // 调试日志
      if (cleanPluginName !== actualFolderName) {
        console.log(`[plugin-static-files] Mapping ${cleanPluginName} -> ${actualFolderName}`);
      }

      // 尝试从多个位置查找文件
      let filePath: string | null = null;

      if (isPackagesPath) {
        // 从 packages 目录查找（使用实际文件夹名）
        filePath = join(pluginBasePath, actualFolderName, relativePath);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          filePath = null;
        }
      } else {
        // 从 node_modules/@tachybase 目录查找（使用实际文件夹名）
        filePath = join(pluginBasePath, actualFolderName, relativePath);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          filePath = null;
        }
      }

      // 如果没找到，尝试从所有可能的位置查找
      if (!filePath) {
        filePath = findPluginFile(pluginName, relativePath);
      }

      if (filePath) {
        // 设置 CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, X-Requested-With');

        // 发送文件
        res.sendFile(filePath);
      } else {
        // 文件不存在，返回 404
        res.status(404).send(`Plugin file not found: ${pluginName}/${relativePath}`);
      }
    });

    Gateway.getInstance().registerHandler({
      name: 'plugin-static-files',
      prefix,
      callback,
    });

    plugin.app.logger.info(`[ModuleWeb] Registered plugin static files service at ${prefix} from ${pluginBasePath}`);
  } else {
    plugin.app.logger.warn('[ModuleWeb] Plugin static files directory not found, skipping registration');
  }
}
