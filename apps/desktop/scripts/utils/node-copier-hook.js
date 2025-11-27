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
 * @param {string} context.appOutDir - 应用输出目录
 * @param {string} context.packager - packager 实例
 * @returns {Promise<void>}
 */
async function copyNodeToApp(context) {
  const { appOutDir } = context;

  console.log(`${logPrefix} Copying node executable to app bundle...`);
  console.log(`${logPrefix} appOutDir: ${appOutDir}`);

  // 在 appOutDir 中查找 .app 包
  // 在 electron-builder 25.1.8 中，appOutDir 指向包含 .app 包的目录
  // 例如：dist/mac-arm64/ 或 dist/mac-x64/

  if (!fs.existsSync(appOutDir)) {
    error(logPrefix, `appOutDir does not exist: ${appOutDir}`);
    throw new Error(`appOutDir does not exist: ${appOutDir}`);
  }

  let resourcesDir = null;

  try {
    const files = fs.readdirSync(appOutDir);
    const appBundle = files.find((file) => file.endsWith('.app'));

    if (!appBundle) {
      error(logPrefix, `No .app bundle found in appOutDir: ${appOutDir}`);
      error(logPrefix, `Contents: ${files.join(', ')}`);
      throw new Error(`No .app bundle found in appOutDir: ${appOutDir}`);
    }

    resourcesDir = path.join(appOutDir, appBundle, 'Contents', 'Resources');

    if (!fs.existsSync(resourcesDir)) {
      error(logPrefix, `Resources directory not found at: ${resourcesDir}`);
      error(logPrefix, `App bundle: ${appBundle}`);
      throw new Error(`Resources directory not found at: ${resourcesDir}`);
    }

    console.log(`${logPrefix} Found app bundle: ${appBundle}`);
    console.log(`${logPrefix} Using Resources directory: ${resourcesDir}`);
  } catch (err) {
    if (err.message.includes('appOutDir') || err.message.includes('Resources')) {
      throw err;
    }
    error(logPrefix, `Error reading appOutDir: ${err.message}`);
    throw new Error(`Error reading appOutDir: ${err.message}`);
  }

  const nodeDestPath = path.join(resourcesDir, 'node');
  console.log(`${logPrefix} Target node path: ${nodeDestPath}`);

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
