#!/usr/bin/env node

/**
 * 清理 Hook
 * 用于 electron-builder 的 afterAllArtifactBuild hook
 * 在构建完成后清理临时文件
 */

const fs = require('fs');
const path = require('path');
const { getDesktopDir } = require('./paths');
const { cleanupAllTempDirs } = require('./temp-manager');
const { removeDirectory } = require('./file-operations');
const { createLogPrefix, success, log } = require('./logger');

const logPrefix = createLogPrefix('cleanup-hook');

/**
 * 清理临时文件和目录
 * @param {Object} context - electron-builder context
 * @returns {Promise<void>}
 */
async function cleanupTempFiles(context) {
  log(logPrefix, 'Cleaning up temporary files...');

  // 清理统一的临时目录（.build-temp）
  try {
    cleanupAllTempDirs();
  } catch (err) {
    log(logPrefix, `Warning: Failed to cleanup .build-temp: ${err.message}`);
  }

  // 兼容性：清理旧的 backend-temp 目录（向后兼容）
  const desktopDir = getDesktopDir();
  const backendTempPath = path.join(desktopDir, 'backend-temp');
  if (fs.existsSync(backendTempPath)) {
    removeDirectory(backendTempPath, logPrefix);
    success(logPrefix, 'Cleaned up legacy backend-temp directory');
  }

  // 可以在这里添加其他临时目录的清理
  // 例如：web-dist-temp, temp-dmg 等
}

module.exports = {
  cleanupTempFiles,
};
