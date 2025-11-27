#!/usr/bin/env node

/**
 * Node 可执行文件复制 Hook
 * 用于 electron-builder 的 afterPack hook
 * 在打包后自动复制 node 可执行文件到应用包中
 */

const fs = require('fs');
const path = require('path');
const { findNodeExecutable, verifyNodeVersion } = require('./node-finder');
const { copyExecutable, removeFile } = require('./file-operations');
const { createLogPrefix, success, warn, error } = require('./logger');

const logPrefix = createLogPrefix('node-copier-hook');

/**
 * 复制 node 可执行文件到应用包
 * @param {Object} context - electron-builder context
 * @param {string} context.appOutDir - 应用输出目录（.app/Contents）
 * @param {string} context.packager - packager 实例
 * @returns {Promise<void>}
 */
async function copyNodeToApp(context) {
  const { appOutDir } = context;
  const resourcesDir = path.join(appOutDir, 'Resources');
  const nodeDestPath = path.join(resourcesDir, 'node');

  console.log(`${logPrefix} Copying node executable to app bundle...`);

  // 检查目标目录是否存在
  if (!fs.existsSync(resourcesDir)) {
    error(logPrefix, `Resources directory not found at ${resourcesDir}`);
    throw new Error('Resources directory not found');
  }

  // 查找系统的 node 可执行文件
  const nodeSourcePath = findNodeExecutable(logPrefix);

  if (!nodeSourcePath) {
    warn(logPrefix, 'Could not find node executable. Backend server may not work without system node.');
    warn(logPrefix, 'Please ensure node is installed and available in PATH.');
    return; // 不抛出错误，允许继续
  }

  // 删除已存在的 node
  removeFile(nodeDestPath);

  // 复制 node 文件
  if (copyExecutable(nodeSourcePath, nodeDestPath, logPrefix)) {
    // 验证复制结果
    if (fs.existsSync(nodeDestPath)) {
      const stats = fs.statSync(nodeDestPath);
      success(logPrefix, 'Node copied successfully');
      console.log(`${logPrefix} Node size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      // 验证 node 版本
      verifyNodeVersion(nodeDestPath, logPrefix);
    } else {
      error(logPrefix, 'Failed to copy node');
      throw new Error('Failed to copy node executable');
    }
  } else {
    error(logPrefix, 'Failed to copy node executable');
    throw new Error('Failed to copy node executable');
  }
}

module.exports = {
  copyNodeToApp,
};
