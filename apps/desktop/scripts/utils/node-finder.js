#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * 查找系统的 node 可执行文件
 * @param {string} logPrefix - 日志前缀
 * @returns {string|null} node 可执行文件路径，如果找不到则返回 null
 */
function findNodeExecutable(logPrefix) {
  // 方法1: 尝试从 PATH 查找
  try {
    const nodePath = execSync('command -v node', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      shell: '/bin/bash',
    }).trim();
    if (nodePath && fs.existsSync(nodePath)) {
      console.log(`${logPrefix} Found node in PATH: ${nodePath}`);
      return nodePath;
    }
  } catch (e) {
    // 继续尝试其他方法
  }

  // 方法2: 尝试从常见路径查找
  const home = process.env.HOME || '';
  const commonPaths = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];

  for (const commonPath of commonPaths) {
    if (fs.existsSync(commonPath)) {
      console.log(`${logPrefix} Found node at: ${commonPath}`);
      return commonPath;
    }
  }

  // 方法3: 如果是 nvm 目录，查找最新版本
  if (home) {
    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      try {
        const versions = fs.readdirSync(nvmVersionsDir);
        const sortedVersions = versions.sort((a, b) => {
          return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
        });
        for (const version of sortedVersions) {
          const versionNodePath = path.join(nvmVersionsDir, version, 'bin', 'node');
          if (fs.existsSync(versionNodePath)) {
            console.log(`${logPrefix} Found nvm node at: ${versionNodePath}`);
            return versionNodePath;
          }
        }
      } catch (e) {
        // 忽略错误
      }
    }
  }

  return null;
}

/**
 * 验证 node 版本
 * @param {string} nodePath - node 可执行文件路径
 * @param {string} logPrefix - 日志前缀
 */
function verifyNodeVersion(nodePath, logPrefix) {
  try {
    const nodeVersion = execSync(`"${nodePath}" --version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    console.log(`${logPrefix} Node version: ${nodeVersion}`);
  } catch (e) {
    console.warn(`${logPrefix} ⚠ Could not verify node version: ${e.message}`);
  }
}

/**
 * 获取 node 可执行文件的路径并确保 PATH 环境变量包含它
 * @returns {string} 更新后的 PATH 环境变量
 */
function ensureNodeInPath() {
  try {
    // 获取当前 node 可执行文件的路径
    const nodePath = process.execPath;
    const nodeDir = path.dirname(nodePath);

    // 获取当前的 PATH
    const currentPath = process.env.PATH || '';

    // 如果 node 目录不在 PATH 中，则添加它
    if (!currentPath.includes(nodeDir)) {
      const separator = process.platform === 'win32' ? ';' : ':';
      return `${nodeDir}${separator}${currentPath}`;
    }

    return currentPath;
  } catch (err) {
    // 如果获取失败，返回原始 PATH
    return process.env.PATH || '';
  }
}

module.exports = {
  findNodeExecutable,
  verifyNodeVersion,
  ensureNodeInPath,
};
