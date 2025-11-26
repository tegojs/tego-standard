#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./utils/paths');
const { createLogPrefix, success, log } = require('./utils/logger');

const logPrefix = createLogPrefix('prepare-web-build');
const projectRoot = getProjectRoot();

// 确保 web 构建所需的 tsconfig.paths.json 可访问
// getUmiConfig() 使用 process.cwd() 查找 tsconfig.paths.json
// 当从 apps/web 目录运行时，需要在 apps/web 目录中有这个文件
const tsconfigPathsRoot = path.join(projectRoot, 'tsconfig.paths.json');
const tsconfigPathsWeb = path.join(projectRoot, 'apps', 'web', 'tsconfig.paths.json');

if (!fs.existsSync(tsconfigPathsRoot)) {
  console.error(`${logPrefix} ✗ tsconfig.paths.json not found at ${tsconfigPathsRoot}`);
  process.exit(1);
}

if (!fs.existsSync(tsconfigPathsWeb)) {
  log(logPrefix, 'Creating symlink for tsconfig.paths.json in apps/web');
  try {
    // 确保 apps/web 目录存在
    const webDir = path.dirname(tsconfigPathsWeb);
    if (!fs.existsSync(webDir)) {
      fs.mkdirSync(webDir, { recursive: true });
    }

    // 尝试创建符号链接
    try {
      fs.symlinkSync(tsconfigPathsRoot, tsconfigPathsWeb, 'file');
      success(logPrefix, 'Created tsconfig.paths.json symlink');
    } catch (err) {
      // 如果符号链接失败（可能因为已存在或权限问题），尝试复制文件
      if (err.code === 'EEXIST') {
        // 如果已存在，检查是否是符号链接
        const stats = fs.lstatSync(tsconfigPathsWeb);
        if (stats.isSymbolicLink()) {
          success(logPrefix, 'tsconfig.paths.json symlink already exists');
        } else {
          log(logPrefix, 'File exists but not a symlink, copying instead');
          fs.copyFileSync(tsconfigPathsRoot, tsconfigPathsWeb);
          success(logPrefix, 'Copied tsconfig.paths.json');
        }
      } else {
        log(logPrefix, 'Symlink failed, copying file instead');
        fs.copyFileSync(tsconfigPathsRoot, tsconfigPathsWeb);
        success(logPrefix, 'Copied tsconfig.paths.json');
      }
    }
  } catch (err) {
    console.error(`${logPrefix} ✗ Failed to prepare tsconfig.paths.json: ${err.message}`);
    process.exit(1);
  }
} else {
  success(logPrefix, 'tsconfig.paths.json already exists in apps/web');
}
