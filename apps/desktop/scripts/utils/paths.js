#!/usr/bin/env node

const path = require('path');

/**
 * 获取 desktop 目录路径
 */
function getDesktopDir() {
  return path.resolve(__dirname, '../..');
}

/**
 * 获取项目根目录路径
 */
function getProjectRoot() {
  const desktopDir = getDesktopDir();
  return path.resolve(desktopDir, '../..');
}

/**
 * 获取 web dist 源目录路径
 * 注意：现在由 electron-builder 的 extraResources 自动处理，此函数保留用于向后兼容
 */
function getWebDistSrc() {
  const desktopDir = getDesktopDir();
  return path.resolve(desktopDir, '../web/dist');
}

/**
 * 获取应用包 Resources 目录路径
 * @param {string} appName - 应用名称
 * @param {string} arch - 架构 ('arm64' | 'x64')，如果不提供则尝试自动检测
 */
function getAppResourcesPath(appName, arch) {
  const desktopDir = getDesktopDir();
  const detectedArch = arch || detectArchitecture(desktopDir, appName);
  return path.resolve(desktopDir, `dist/mac-${detectedArch}/${appName}.app/Contents/Resources`);
}

/**
 * 获取应用包路径
 * @param {string} appName - 应用名称
 * @param {string} arch - 架构 ('arm64' | 'x64')，如果不提供则尝试自动检测
 */
function getAppBundlePath(appName, arch) {
  const desktopDir = getDesktopDir();
  const detectedArch = arch || detectArchitecture(desktopDir, appName);
  return path.resolve(desktopDir, `dist/mac-${detectedArch}/${appName}.app`);
}

/**
 * 获取 DMG 路径
 * @param {string} appName - 应用名称
 * @param {string} version - 版本号
 * @param {string} arch - 架构 ('arm64' | 'x64')，如果不提供则尝试自动检测
 */
function getDmgPath(appName, version, arch) {
  const desktopDir = getDesktopDir();
  const detectedArch = arch || detectArchitecture(desktopDir, appName);
  return path.resolve(desktopDir, `dist/${appName}-${version}-${detectedArch}.dmg`);
}

/**
 * 检测架构（自动检测已构建的架构）
 * @param {string} desktopDir - desktop 目录
 * @param {string} appName - 应用名称
 * @returns {string} 架构 ('arm64' | 'x64')
 */
function detectArchitecture(desktopDir, appName) {
  const fs = require('fs');
  // 优先检测 arm64（Apple Silicon）
  const arm64Path = path.resolve(desktopDir, `dist/mac-arm64/${appName}.app`);
  if (fs.existsSync(arm64Path)) {
    return 'arm64';
  }
  // 回退到 x64（Intel）
  const x64Path = path.resolve(desktopDir, `dist/mac-x64/${appName}.app`);
  if (fs.existsSync(x64Path)) {
    return 'x64';
  }
  // 默认返回当前系统架构
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/**
 * 获取所有已构建的架构
 * @param {string} desktopDir - desktop 目录
 * @param {string} appName - 应用名称
 * @returns {string[]} 架构列表
 */
function getBuiltArchitectures(desktopDir, appName) {
  const fs = require('fs');
  const architectures = [];
  const arm64Path = path.resolve(desktopDir, `dist/mac-arm64/${appName}.app`);
  const x64Path = path.resolve(desktopDir, `dist/mac-x64/${appName}.app`);

  if (fs.existsSync(arm64Path)) {
    architectures.push('arm64');
  }
  if (fs.existsSync(x64Path)) {
    architectures.push('x64');
  }

  return architectures;
}

module.exports = {
  getDesktopDir,
  getProjectRoot,
  getWebDistSrc,
  getAppResourcesPath,
  getAppBundlePath,
  getDmgPath,
  detectArchitecture,
  getBuiltArchitectures,
};
