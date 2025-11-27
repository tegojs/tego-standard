const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { removeDirectory, ensureDirectory } = require('../utils/file-operations');
const { createLogPrefix, success, error, log } = require('../utils/logger');

/**
 * 需要复制的文件和目录
 */
const BACKEND_ITEMS_TO_COPY = [
  { src: 'packages', dest: 'packages' },
  { src: 'package.json', dest: 'package.json' },
  { src: 'pnpm-workspace.yaml', dest: 'pnpm-workspace.yaml' },
  { src: '.env.example', dest: '.env.example' },
];

/**
 * 需要复制到 backend 的脚本文件（用于运行时）
 */
const BACKEND_SCRIPTS_TO_COPY = [
  { src: path.join(__dirname, 'tego-wrapper.js'), dest: 'scripts/tego-wrapper.js' },
  { src: path.join(__dirname, 'tego-wrapper-utils.js'), dest: 'scripts/tego-wrapper-utils.js' },
];

/**
 * 创建 @tachybase 目录结构，让 tego 能够通过 PLUGIN_PATHS 找到插件
 * tego 期望的路径格式是: basePath/@tachybase/plugin-name/package.json
 * 但实际目录结构是: packages/plugin-name/package.json
 * 所以我们需要创建 packages/@tachybase/ 目录，并创建符号链接指向实际的插件目录
 */
function createTachybasePluginStructure(backendTemp, logPrefix) {
  const packagesDir = path.join(backendTemp, 'packages');
  const tachybaseDir = path.join(packagesDir, '@tachybase');

  if (!fs.existsSync(packagesDir)) {
    log(logPrefix, 'Packages directory not found, skipping @tachybase structure creation');
    return;
  }

  try {
    // 创建 @tachybase 目录
    if (!fs.existsSync(tachybaseDir)) {
      fs.mkdirSync(tachybaseDir, { recursive: true });
      log(logPrefix, 'Created @tachybase directory');
    }

    // 遍历 packages 目录，为所有 plugin- 开头的目录创建符号链接
    const entries = fs.readdirSync(packagesDir);
    for (const entry of entries) {
      if (entry.startsWith('plugin-')) {
        const pluginDir = path.join(packagesDir, entry);
        const pluginPackageJson = path.join(pluginDir, 'package.json');

        // 检查是否是有效的插件（有 package.json 且 name 以 @tachybase/plugin- 开头）
        if (fs.existsSync(pluginPackageJson)) {
          try {
            const pkgJson = JSON.parse(fs.readFileSync(pluginPackageJson, 'utf8'));
            if (pkgJson.name && pkgJson.name.startsWith('@tachybase/plugin-')) {
              const linkPath = path.join(tachybaseDir, entry);

              // 如果符号链接已存在，先删除
              if (fs.existsSync(linkPath)) {
                try {
                  const stats = fs.lstatSync(linkPath);
                  if (stats.isSymbolicLink()) {
                    fs.unlinkSync(linkPath);
                  }
                } catch (e) {
                  // 忽略错误
                }
              }

              // 创建符号链接（使用相对路径，这样更可靠）
              const relativePath = path.relative(tachybaseDir, pluginDir);
              fs.symlinkSync(relativePath, linkPath, 'dir');
              log(logPrefix, `Created symlink: @tachybase/${entry} -> ${entry}`);
            }
          } catch (err) {
            log(logPrefix, `Warning: Could not process ${entry}: ${err.message}`);
          }
        }
      }
    }

    success(logPrefix, 'Created @tachybase plugin structure');
  } catch (err) {
    error(logPrefix, `Failed to create @tachybase structure: ${err.message}`);
    // 不退出，因为这可能不是致命错误
  }
}

/**
 * 复制后端文件到临时目录
 */
function copyBackendFiles(projectRoot, backendTemp, logPrefix) {
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

  // 复制完成后，创建 @tachybase 目录结构
  createTachybasePluginStructure(backendTemp, logPrefix);

  // 复制 wrapper 脚本到 backend 目录
  copyBackendScripts(backendTemp, logPrefix);
}

/**
 * 复制 wrapper 脚本到 backend 目录
 */
function copyBackendScripts(backendTemp, logPrefix) {
  log(logPrefix, 'Copying backend scripts...');
  log(logPrefix, `Backend temp directory: ${backendTemp}`);
  log(logPrefix, `Scripts to copy: ${BACKEND_SCRIPTS_TO_COPY.length}`);

  for (const item of BACKEND_SCRIPTS_TO_COPY) {
    const srcPath = item.src;
    const destPath = path.join(backendTemp, item.dest);
    const destDir = path.dirname(destPath);

    log(logPrefix, `Checking source: ${srcPath}`);
    log(logPrefix, `Destination: ${destPath}`);

    if (fs.existsSync(srcPath)) {
      try {
        // 确保目标目录存在
        if (!fs.existsSync(destDir)) {
          log(logPrefix, `Creating directory: ${destDir}`);
          fs.mkdirSync(destDir, { recursive: true });
        }
        log(logPrefix, `Copying ${path.basename(srcPath)} to ${item.dest}...`);
        fs.copyFileSync(srcPath, destPath);
        // 确保脚本有执行权限
        fs.chmodSync(destPath, 0o755);
        success(logPrefix, `Copied ${path.basename(srcPath)} to ${item.dest}`);

        // 验证文件是否真的被复制了
        if (fs.existsSync(destPath)) {
          log(logPrefix, `✓ Verified: ${destPath} exists`);
        } else {
          error(logPrefix, `✗ Verification failed: ${destPath} does not exist after copy`);
        }
      } catch (err) {
        error(logPrefix, `Failed to copy ${path.basename(srcPath)}: ${err.message}`);
        error(logPrefix, `Error stack: ${err.stack}`);
        process.exit(1);
      }
    } else {
      error(logPrefix, `Source script not found: ${srcPath}`);
      error(logPrefix, `Current working directory: ${process.cwd()}`);
      error(logPrefix, `__dirname: ${__dirname}`);
      process.exit(1);
    }
  }
}

/**
 * 准备临时目录
 */
function prepareTempDirectory(backendTemp, logPrefix) {
  removeDirectory(backendTemp, logPrefix);
  ensureDirectory(backendTemp);
}

module.exports = {
  copyBackendFiles,
  prepareTempDirectory,
};
