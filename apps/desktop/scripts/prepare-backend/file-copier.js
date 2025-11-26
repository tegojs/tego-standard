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
