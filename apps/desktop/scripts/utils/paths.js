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
 */
function getAppResourcesPath(appName) {
  const desktopDir = getDesktopDir();
  return path.resolve(desktopDir, `dist/mac-arm64/${appName}.app/Contents/Resources`);
}

/**
 * 获取应用包路径
 * @param {string} appName - 应用名称
 */
function getAppBundlePath(appName) {
  const desktopDir = getDesktopDir();
  return path.resolve(desktopDir, `dist/mac-arm64/${appName}.app`);
}

/**
 * 获取 DMG 路径
 * @param {string} appName - 应用名称
 * @param {string} version - 版本号
 */
function getDmgPath(appName, version) {
  const desktopDir = getDesktopDir();
  return path.resolve(desktopDir, `dist/${appName}-${version}-arm64.dmg`);
}

module.exports = {
  getDesktopDir,
  getProjectRoot,
  getWebDistSrc,
  getAppResourcesPath,
  getAppBundlePath,
  getDmgPath,
};
