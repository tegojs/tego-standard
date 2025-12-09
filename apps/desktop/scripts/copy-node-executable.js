#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getAppResourcesPath } = require('./utils/paths');
const { copyExecutable, removeFile } = require('./utils/file-operations');
const { detectAppName } = require('./utils/app-detector');
const { findNodeExecutable, verifyNodeVersion } = require('./utils/node-finder');
const { createLogPrefix, success, warn, error } = require('./utils/logger');

const logPrefix = createLogPrefix('copy-node-executable');

// 检测应用名称
const appName = detectAppName();
const appPath = getAppResourcesPath(appName);
const nodeDestPath = path.join(appPath, 'node');

console.log(`${logPrefix} Copying node executable to app bundle...`);

// 检查目标目录是否存在
if (!fs.existsSync(appPath)) {
  error(logPrefix, `App Resources directory not found at ${appPath}`);
  error(logPrefix, 'Make sure electron-builder has completed successfully');
  process.exit(1);
}

// 查找系统的 node 可执行文件
const nodeSourcePath = findNodeExecutable(logPrefix);

if (!nodeSourcePath) {
  warn(logPrefix, 'Could not find node executable. Backend server may not work without system node.');
  warn(logPrefix, 'Please ensure node is installed and available in PATH.');
  process.exit(0); // 不退出，允许继续
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
  }
}
