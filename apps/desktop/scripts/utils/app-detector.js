#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getDesktopDir } = require('./paths');

/**
 * 检测应用名称
 * 扫描 dist/mac-arm64 目录查找 .app 文件
 * @param {string} defaultName - 默认应用名称
 * @returns {string} 应用名称
 */
function detectAppName(defaultName = 'Tachybase') {
  const desktopDir = getDesktopDir();
  const macArm64Dir = path.resolve(desktopDir, 'dist/mac-arm64');

  if (!fs.existsSync(macArm64Dir)) {
    return defaultName;
  }

  try {
    const files = fs.readdirSync(macArm64Dir);
    const appBundle = files.find((file) => file.endsWith('.app'));
    if (appBundle) {
      return appBundle.replace('.app', '');
    }
  } catch (err) {
    // 忽略错误，返回默认值
  }

  return defaultName;
}

/**
 * 从 package.json 读取应用信息
 * @returns {object} package.json 内容
 */
function getPackageInfo() {
  const desktopDir = getDesktopDir();
  const packageJsonPath = path.join(desktopDir, 'package.json');
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

module.exports = {
  detectAppName,
  getPackageInfo,
};
