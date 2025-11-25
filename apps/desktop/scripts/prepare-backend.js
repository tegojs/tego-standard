#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getProjectRoot } = require('./utils/paths');
const { removeDirectory, ensureDirectory } = require('./utils/file-operations');
const { createLogPrefix, success, error, log, warn } = require('./utils/logger');

const logPrefix = createLogPrefix('prepare-backend');

const projectRoot = getProjectRoot();
const backendTemp = path.resolve(__dirname, '..', 'backend-temp');

console.log(`${logPrefix} Preparing backend for packaging...`);
console.log(`${logPrefix} Project root: ${projectRoot}`);
console.log(`${logPrefix} Backend temp: ${backendTemp}`);

// 检查项目根目录
if (!fs.existsSync(projectRoot)) {
  error(logPrefix, `Project root not found at ${projectRoot}`);
  process.exit(1);
}

// 清理临时目录
removeDirectory(backendTemp, logPrefix);

// 创建临时目录
ensureDirectory(backendTemp);

// 需要复制的文件和目录
const BACKEND_ITEMS_TO_COPY = [
  { src: 'packages', dest: 'packages' },
  { src: 'package.json', dest: 'package.json' },
  { src: 'pnpm-workspace.yaml', dest: 'pnpm-workspace.yaml' },
  { src: '.env.example', dest: '.env.example' },
];

// 复制后端文件
log(logPrefix, 'Copying backend files...');
for (const item of BACKEND_ITEMS_TO_COPY) {
  const srcPath = path.join(projectRoot, item.src);
  const destPath = path.join(backendTemp, item.dest);

  if (fs.existsSync(srcPath)) {
    try {
      const stats = fs.lstatSync(srcPath);
      if (stats.isDirectory()) {
        execSync(`cp -R "${srcPath}" "${destPath}"`, { stdio: 'inherit' });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      success(logPrefix, `Copied ${item.src}`);
    } catch (err) {
      error(logPrefix, `Failed to copy ${item.src}: ${err.message}`);
      process.exit(1);
    }
  } else {
    error(logPrefix, `Source not found: ${srcPath}`);
    process.exit(1);
  }
}

// tego 在根 package.json 中是 devDependency，但后端需要它
// 修改 backend-temp/package.json 来添加 tego 作为生产依赖
const packageJsonPath = path.join(backendTemp, 'package.json');
log(logPrefix, 'Adding tego to dependencies (required for backend server)...');
try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // 确保 dependencies 对象存在
  if (!packageJson.dependencies) {
    packageJson.dependencies = {};
  }

  // 从 devDependencies 中获取 tego 的版本
  // 如果版本是 'catalog:'，从 pnpm-workspace.yaml 中读取实际版本
  let tegoVersion = packageJson.devDependencies?.tego;

  if (!tegoVersion || tegoVersion === 'catalog:') {
    // 读取 pnpm-workspace.yaml 获取 catalog 中的版本
    const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
    if (fs.existsSync(workspaceYamlPath)) {
      const yamlContent = fs.readFileSync(workspaceYamlPath, 'utf8');
      const catalogMatch = yamlContent.match(/^  tego:\s*([^\s]+)/m);
      if (catalogMatch) {
        tegoVersion = catalogMatch[1];
        log(logPrefix, `Found tego version in catalog: ${tegoVersion}`);
      }
    }

    // 如果还是找不到，使用默认版本
    if (!tegoVersion || tegoVersion === 'catalog:') {
      tegoVersion = '1.3.52'; // 从 pnpm-workspace.yaml 中看到的版本
      log(logPrefix, `Using default tego version: ${tegoVersion}`);
    }
  }

  packageJson.dependencies.tego = tegoVersion;

  // 移除开发相关的安装脚本，因为这些工具在生产依赖安装时不可用
  // 这些脚本在临时目录中不需要执行
  if (packageJson.scripts) {
    if (packageJson.scripts.postinstall) {
      delete packageJson.scripts.postinstall;
      log(logPrefix, 'Removed postinstall script (tachybase not available in production install)');
    }
    // preinstall 脚本用于检查包管理器，在生产安装时不需要
    if (packageJson.scripts.preinstall) {
      delete packageJson.scripts.preinstall;
      log(logPrefix, 'Removed preinstall script');
    }
    // prepare 脚本用于设置 Git hooks，在生产环境中不需要
    if (packageJson.scripts.prepare) {
      delete packageJson.scripts.prepare;
      log(logPrefix, 'Removed prepare script (husky not needed in production)');
    }
  }

  // 替换所有 catalog: 引用为实际版本号（因为使用 --ignore-workspace 时无法解析 catalog）
  const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
  let catalogMap = {};
  if (fs.existsSync(workspaceYamlPath)) {
    const yamlContent = fs.readFileSync(workspaceYamlPath, 'utf8');

    // 解析 catalog 中的所有条目
    const catalogLines = yamlContent.split('\n');
    let inCatalog = false;
    for (const line of catalogLines) {
      if (line.trim() === 'catalog:') {
        inCatalog = true;
        continue;
      }
      if (inCatalog) {
        if (line.match(/^\w/)) {
          // 新的一级键，退出 catalog
          break;
        }
        // 匹配带引号或不带引号的键，例如: '  "@tego/devkit": 1.3.52' 或 '  tego: 1.3.52'
        // 支持单引号、双引号或无引号
        let match = line.match(/^\s+['"]([^'"]+)['"]:\s*(.+)$/); // 带引号的键
        if (!match) {
          match = line.match(/^\s+([^:]+):\s*(.+)$/); // 不带引号的键
        }
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim();
          catalogMap[key] = value;
        }
      }
    }
  }

  // 替换 dependencies 和 devDependencies 中的 catalog: 引用
  const replaceCatalogRefs = (deps) => {
    if (!deps) return;
    for (const [key, value] of Object.entries(deps)) {
      if (value === 'catalog:' && catalogMap[key]) {
        deps[key] = catalogMap[key];
        log(logPrefix, `Replaced catalog: reference for ${key} with version ${catalogMap[key]}`);
      }
    }
  };

  replaceCatalogRefs(packageJson.dependencies);
  replaceCatalogRefs(packageJson.devDependencies);
  replaceCatalogRefs(packageJson.optionalDependencies);

  // 递归处理 packages 目录中的所有 package.json
  const packagesDir = path.join(backendTemp, 'packages');
  if (fs.existsSync(packagesDir)) {
    const processPackageJson = (dir) => {
      const packageJsonFile = path.join(dir, 'package.json');
      if (fs.existsSync(packageJsonFile)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(packageJsonFile, 'utf8'));
          let modified = false;

          const replaceInPkg = (deps) => {
            if (!deps) return;
            for (const [key, value] of Object.entries(deps)) {
              if (value === 'catalog:' && catalogMap[key]) {
                deps[key] = catalogMap[key];
                modified = true;
              }
            }
          };

          replaceInPkg(pkgJson.dependencies);
          replaceInPkg(pkgJson.devDependencies);
          replaceInPkg(pkgJson.optionalDependencies);
          replaceInPkg(pkgJson.peerDependencies);

          if (modified) {
            fs.writeFileSync(packageJsonFile, JSON.stringify(pkgJson, null, 2) + '\n');
            log(logPrefix, `Updated catalog references in ${path.relative(backendTemp, packageJsonFile)}`);
          }
        } catch (err) {
          // 忽略单个包的错误，继续处理其他包
          log(logPrefix, `Warning: Could not process ${packageJsonFile}: ${err.message}`);
        }
      }

      // 递归处理子目录
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const entryPath = path.join(dir, entry);
          const stat = fs.lstatSync(entryPath);
          if (stat.isDirectory()) {
            processPackageJson(entryPath);
          }
        }
      } catch (err) {
        // 忽略读取错误
      }
    };

    processPackageJson(packagesDir);
  }

  // 写入修改后的 package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  success(logPrefix, `Added tego to dependencies with version: ${tegoVersion}`);

  // 验证 postinstall 脚本是否已被删除
  const packageJsonVerify = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJsonVerify.scripts?.postinstall) {
    error(logPrefix, 'postinstall script was not removed correctly');
    error(logPrefix, `Current scripts: ${JSON.stringify(packageJsonVerify.scripts, null, 2)}`);
    process.exit(1);
  }
  log(logPrefix, 'Verified postinstall script has been removed');
} catch (err) {
  error(logPrefix, `Failed to add tego to dependencies: ${err.message}`);
  process.exit(1);
}

// 在临时目录中安装生产依赖
// 使用 pnpm install --prod 安装生产依赖，pnpm 会自动处理 workspace 和依赖关系
log(logPrefix, 'Installing production dependencies with pnpm...');
try {
  // 不复制 pnpm-lock.yaml，因为 lockfile 是基于 isolated 模式生成的
  // 而我们在 backend-temp 中使用 hoisted 模式，会导致配置不匹配
  // 让 pnpm 重新生成 lockfile 以匹配新的配置

  // 验证 package.json 中是否包含 tego
  const packageJsonAfter = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!packageJsonAfter.dependencies?.tego) {
    error(logPrefix, 'tego was not added to dependencies correctly');
    error(logPrefix, `Current dependencies: ${JSON.stringify(packageJsonAfter.dependencies || {}, null, 2)}`);
    process.exit(1);
  }
  log(logPrefix, `Verified tego in dependencies: ${packageJsonAfter.dependencies.tego}`);

  // 临时移除 pnpm-workspace.yaml，因为 backend-temp 不应该被视为 workspace
  // 这会导致依赖安装问题，特别是当使用 pnpm add 时
  const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
  const workspaceYamlBackup = path.join(backendTemp, 'pnpm-workspace.yaml.backup');
  let workspaceYamlExists = false;
  if (fs.existsSync(workspaceYamlPath)) {
    fs.renameSync(workspaceYamlPath, workspaceYamlBackup);
    workspaceYamlExists = true;
    log(logPrefix, 'Temporarily removed pnpm-workspace.yaml to avoid workspace conflicts');
  }

  // 创建 .npmrc 文件，强制使用 hoisted 模式以确保包正确提升
  // 同时禁用 workspace 链接以避免与父目录的 node_modules 冲突
  const npmrcPath = path.join(backendTemp, '.npmrc');
  fs.writeFileSync(npmrcPath, 'node-linker=hoisted\nlink-workspace-packages=false\n', 'utf8');
  log(logPrefix, 'Created .npmrc with node-linker=hoisted and link-workspace-packages=false');

  try {
    // 安装生产依赖
    // --prod: 只安装生产依赖
    // --ignore-scripts: 跳过所有脚本执行（包括 postinstall），因为 tachybase 在生产环境中不可用
    // --no-frozen-lockfile: 允许 pnpm 更新 lockfile 以匹配新的配置（hoisted 模式）
    // node-linker=hoisted 已在 .npmrc 中配置，不需要 --shamefully-hoist 标志（在 pnpm v10 中已废弃）
    // --ignore-workspace: 确保 pnpm 将其视为独立项目，避免与父目录的 workspace 冲突
    execSync('pnpm install --prod --ignore-scripts --ignore-workspace --no-frozen-lockfile', {
      cwd: backendTemp,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    success(logPrefix, 'Dependencies installed successfully');
  } finally {
    // 恢复 pnpm-workspace.yaml（如果需要的话）
    if (workspaceYamlExists && fs.existsSync(workspaceYamlBackup)) {
      fs.renameSync(workspaceYamlBackup, workspaceYamlPath);
      log(logPrefix, 'Restored pnpm-workspace.yaml');
    }
  }
} catch (err) {
  error(logPrefix, `Failed to install dependencies: ${err.message}`);
  process.exit(1);
}

// 验证安装结果
const nodeModulesPath = path.join(backendTemp, 'node_modules');
// 在 pnpm isolated 模式下，包可能在 .pnpm 中，但 node_modules 中应该有符号链接
// 检查 tego.js 文件是否存在（这是实际需要的文件）
const tegoJsPath = path.join(nodeModulesPath, 'tego', 'bin', 'tego.js');
const tegoBinPath = path.join(nodeModulesPath, '.bin', 'tego');
const tegoPath = path.join(nodeModulesPath, 'tego');

// 辅助函数：检查文件是否存在（包括符号链接）
function checkTegoExists() {
  // 检查标准路径
  if (fs.existsSync(tegoJsPath)) return true;
  if (fs.existsSync(tegoBinPath)) return true;
  if (fs.existsSync(tegoPath)) return true;

  // 检查 .pnpm 目录（isolated 模式）
  const pnpmPath = path.join(nodeModulesPath, '.pnpm');
  if (fs.existsSync(pnpmPath)) {
    // 查找 tego 包在 .pnpm 中的位置
    try {
      const pnpmEntries = fs.readdirSync(pnpmPath);
      for (const entry of pnpmEntries) {
        if (entry.startsWith('tego@')) {
          const tegoPnpmPath = path.join(pnpmPath, entry, 'node_modules', 'tego');
          if (fs.existsSync(tegoPnpmPath)) {
            const tegoJsPnpmPath = path.join(tegoPnpmPath, 'bin', 'tego.js');
            if (fs.existsSync(tegoJsPnpmPath)) {
              log(logPrefix, `Found tego in .pnpm directory: ${tegoPnpmPath}`);
              return true;
            }
          }
        }
      }
    } catch (err) {
      // 忽略读取错误
    }
  }

  return false;
}

// 检查 tego.js 或 .bin/tego 是否存在
if (!checkTegoExists()) {
  // 尝试显式安装 tego
  log(logPrefix, 'tego not found after install, attempting explicit installation...');
  try {
    const packageJsonAfter = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const tegoVersion = packageJsonAfter.dependencies?.tego || '1.3.52';
    log(logPrefix, `Installing tego@${tegoVersion} explicitly...`);

    // 清理 node_modules 以避免依赖类型冲突
    // 这是因为第一次安装使用了 --prod，而 pnpm add 可能会检测到冲突
    if (fs.existsSync(nodeModulesPath)) {
      log(logPrefix, 'Cleaning node_modules to avoid dependency type conflicts...');
      removeDirectory(nodeModulesPath, logPrefix);
    }

    // 临时移除 pnpm-workspace.yaml 以避免 workspace 冲突
    const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
    const workspaceYamlBackup = path.join(backendTemp, 'pnpm-workspace.yaml.backup');
    let workspaceYamlExists = false;
    if (fs.existsSync(workspaceYamlPath)) {
      fs.renameSync(workspaceYamlPath, workspaceYamlBackup);
      workspaceYamlExists = true;
      log(logPrefix, 'Temporarily removed pnpm-workspace.yaml for explicit installation');
    }

    // 确保 .npmrc 存在并配置为 hoisted 模式
    // 同时禁用 workspace 链接以避免与父目录的 node_modules 冲突
    const npmrcPath = path.join(backendTemp, '.npmrc');
    if (!fs.existsSync(npmrcPath)) {
      fs.writeFileSync(npmrcPath, 'node-linker=hoisted\nlink-workspace-packages=false\n', 'utf8');
      log(logPrefix, 'Created .npmrc with node-linker=hoisted and link-workspace-packages=false');
    } else {
      // 确保配置包含 link-workspace-packages=false
      const npmrcContent = fs.readFileSync(npmrcPath, 'utf8');
      if (!npmrcContent.includes('link-workspace-packages=false')) {
        fs.appendFileSync(npmrcPath, 'link-workspace-packages=false\n');
        log(logPrefix, 'Added link-workspace-packages=false to .npmrc');
      }
    }

    try {
      // 清理 pnpm-lock.yaml 以避免依赖类型冲突
      const lockFilePath = path.join(backendTemp, 'pnpm-lock.yaml');
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
        log(logPrefix, 'Removed pnpm-lock.yaml to avoid dependency type conflicts');
      }

      // 使用 pnpm add 显式安装 tego，这样可以确保它被正确安装
      // 即使 package.json 中已经包含了 tego，使用 add 命令可以确保它被正确解析和安装
      // node-linker=hoisted 已在 .npmrc 中配置，不需要 --shamefully-hoist 标志（在 pnpm v10 中已废弃）
      // 使用 --ignore-workspace 确保 pnpm 将其视为独立项目，避免与父目录的 workspace 冲突
      log(logPrefix, `Installing tego@${tegoVersion} using pnpm add...`);
      execSync(`pnpm add tego@${tegoVersion} --save-prod --ignore-scripts --ignore-workspace`, {
        cwd: backendTemp,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' },
      });

      success(logPrefix, 'tego installed successfully');
    } finally {
      // 恢复 pnpm-workspace.yaml
      if (workspaceYamlExists && fs.existsSync(workspaceYamlBackup)) {
        fs.renameSync(workspaceYamlBackup, workspaceYamlPath);
        log(logPrefix, 'Restored pnpm-workspace.yaml');
      }
    }

    // 再次检查
    if (!checkTegoExists()) {
      error(logPrefix, 'tego package still not found after explicit installation');
      error(logPrefix, `Expected tego.js at: ${tegoJsPath}`);
      error(logPrefix, `Expected tego bin at: ${tegoBinPath}`);
      error(logPrefix, `Expected tego directory at: ${tegoPath}`);

      // 添加调试信息：列出 node_modules 的内容
      if (fs.existsSync(nodeModulesPath)) {
        try {
          const entries = fs.readdirSync(nodeModulesPath);
          log(
            logPrefix,
            `node_modules contents: ${entries.slice(0, 20).join(', ')}${entries.length > 20 ? '...' : ''}`,
          );

          // 检查 .pnpm 目录
          const pnpmPath = path.join(nodeModulesPath, '.pnpm');
          if (fs.existsSync(pnpmPath)) {
            try {
              const pnpmEntries = fs.readdirSync(pnpmPath);
              log(
                logPrefix,
                `.pnpm contents: ${pnpmEntries.slice(0, 10).join(', ')}${pnpmEntries.length > 10 ? '...' : ''}`,
              );
            } catch (err) {
              log(logPrefix, `Could not read .pnpm: ${err.message}`);
            }
          }
        } catch (err) {
          log(logPrefix, `Could not read node_modules: ${err.message}`);
        }
      } else {
        log(logPrefix, 'node_modules directory does not exist');
      }

      process.exit(1);
    }
  } catch (err) {
    error(logPrefix, `Failed to install tego explicitly: ${err.message}`);
    error(logPrefix, `Expected tego.js at: ${tegoJsPath}`);
    error(logPrefix, `Expected tego bin at: ${tegoBinPath}`);
    error(logPrefix, `Expected tego directory at: ${tegoPath}`);

    // 添加调试信息
    if (fs.existsSync(nodeModulesPath)) {
      try {
        const entries = fs.readdirSync(nodeModulesPath);
        log(logPrefix, `node_modules contents: ${entries.slice(0, 20).join(', ')}${entries.length > 20 ? '...' : ''}`);
      } catch (readErr) {
        log(logPrefix, `Could not read node_modules: ${readErr.message}`);
      }
    }

    process.exit(1);
  }
}

// 最终验证：确保 tego 已安装
if (!checkTegoExists()) {
  error(logPrefix, 'tego package verification failed');
  process.exit(1);
}
success(logPrefix, 'tego package verified');

// chalk 是 tego 的依赖，应该会自动安装
// 但为了确保，我们也检查一下
const chalkPath = path.join(nodeModulesPath, 'chalk');
if (!fs.existsSync(chalkPath)) {
  log(logPrefix, 'chalk not found, installing...');
  try {
    // 临时移除 pnpm-workspace.yaml 以避免 workspace 冲突
    const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
    const workspaceYamlBackup = path.join(backendTemp, 'pnpm-workspace.yaml.backup');
    let workspaceYamlExists = false;
    if (fs.existsSync(workspaceYamlPath)) {
      fs.renameSync(workspaceYamlPath, workspaceYamlBackup);
      workspaceYamlExists = true;
      log(logPrefix, 'Temporarily removed pnpm-workspace.yaml for chalk installation');
    }

    try {
      execSync('pnpm add chalk --save-prod --ignore-scripts', {
        cwd: backendTemp,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' },
      });
    } finally {
      // 恢复 pnpm-workspace.yaml
      if (workspaceYamlExists && fs.existsSync(workspaceYamlBackup)) {
        fs.renameSync(workspaceYamlBackup, workspaceYamlPath);
        log(logPrefix, 'Restored pnpm-workspace.yaml');
      }
    }
  } catch (err) {
    // chalk 可能不是必需的，只记录警告
    log(logPrefix, `Warning: Could not install chalk: ${err.message}`);
  }
}

// 检查并构建 sqlite3 原生模块（如果需要）
// 由于使用了 --ignore-scripts，sqlite3 的原生模块可能没有被构建
log(logPrefix, 'Checking sqlite3 native module...');

// 查找 sqlite3 包的实际位置
let sqlite3Path = path.join(nodeModulesPath, 'sqlite3');
let sqlite3ActualPath = sqlite3Path;

// 检查 .pnpm 目录中的 sqlite3（如果使用 isolated 模式）
const pnpmPath = path.join(nodeModulesPath, '.pnpm');
if (!fs.existsSync(sqlite3Path) && fs.existsSync(pnpmPath)) {
  try {
    const pnpmEntries = fs.readdirSync(pnpmPath);
    for (const entry of pnpmEntries) {
      if (entry.startsWith('sqlite3@')) {
        const sqlite3PnpmPath = path.join(pnpmPath, entry, 'node_modules', 'sqlite3');
        if (fs.existsSync(sqlite3PnpmPath)) {
          sqlite3ActualPath = sqlite3PnpmPath;
          log(logPrefix, `Found sqlite3 package at: ${sqlite3ActualPath}`);
          break;
        }
      }
    }
  } catch (err) {
    log(logPrefix, `Warning: Could not search .pnpm directory: ${err.message}`);
  }
}

// 检查 sqlite3 是否已安装
if (fs.existsSync(sqlite3ActualPath)) {
  // 检查原生模块是否已构建
  const sqlite3BuildPath = path.join(sqlite3ActualPath, 'build', 'Release', 'node_sqlite3.node');
  if (!fs.existsSync(sqlite3BuildPath)) {
    log(logPrefix, 'sqlite3 native module not found, attempting to build...');

    // 获取系统 Node.js 路径（用于构建原生模块，确保 ABI 兼容性）
    const systemNodePath = process.execPath;
    log(logPrefix, `Using system Node.js to build sqlite3: ${systemNodePath}`);
    log(logPrefix, 'This ensures ABI compatibility with the bundled Node.js used at runtime.');

    try {
      log(logPrefix, 'Rebuilding sqlite3 with system Node.js...');

      // 尝试直接使用 node-gyp 构建
      log(logPrefix, 'Attempting direct node-gyp build...');

      // 查找 node-gyp 的路径
      let nodeGypPath;
      try {
        // 尝试从全局 node_modules 查找
        nodeGypPath = require.resolve('node-gyp');
      } catch (err) {
        // 如果找不到，尝试使用 npx
        nodeGypPath = 'npx';
      }

      const buildEnv = { ...process.env };
      if (nodeGypPath !== 'npx') {
        buildEnv.npm_config_node_gyp = nodeGypPath;
      }

      // 使用 node-gyp rebuild 或 npx node-gyp rebuild
      const buildCommand = nodeGypPath === 'npx' ? 'npx node-gyp rebuild' : 'node-gyp rebuild';
      execSync(buildCommand, {
        cwd: sqlite3ActualPath,
        stdio: 'inherit',
        env: buildEnv,
      });

      // 验证构建结果（基于实际路径）
      const actualBuildPath = path.join(sqlite3ActualPath, 'build', 'Release', 'node_sqlite3.node');
      if (fs.existsSync(actualBuildPath)) {
        success(logPrefix, 'sqlite3 native module built successfully');
      } else {
        // 检查其他可能的构建输出路径
        const alternativePaths = [
          path.join(sqlite3ActualPath, 'build', 'Debug', 'node_sqlite3.node'),
          path.join(sqlite3ActualPath, 'lib', 'binding', 'node-v127-darwin-arm64', 'node_sqlite3.node'),
        ];

        let found = false;
        for (const altPath of alternativePaths) {
          if (fs.existsSync(altPath)) {
            success(logPrefix, `sqlite3 native module found at: ${altPath}`);
            found = true;
            break;
          }
        }

        if (!found) {
          warn(logPrefix, 'sqlite3 native module build completed, but output file not found at expected location');
          warn(logPrefix, 'This may cause runtime errors. The module may be built in a different location.');
        }
      }
    } catch (err) {
      warn(logPrefix, `Failed to build sqlite3 native module: ${err.message}`);
      warn(logPrefix, 'The application may still work if sqlite3 is built elsewhere or using a different method.');
    }
  } else {
    success(logPrefix, 'sqlite3 native module already built');
  }
} else {
  log(logPrefix, 'sqlite3 package not found, skipping native module build');
}

success(logPrefix, 'Backend prepared successfully');
console.log(`${logPrefix} Backend directory: ${backendTemp}`);
