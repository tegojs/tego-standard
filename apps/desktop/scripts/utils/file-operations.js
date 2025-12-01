#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * 复制文件或目录（处理符号链接）
 * @param {string} srcPath - 源路径
 * @param {string} destPath - 目标路径
 * @param {string} logPrefix - 日志前缀
 * @returns {boolean} 是否成功
 */
function copyItem(srcPath, destPath, logPrefix) {
  if (!fs.existsSync(srcPath)) {
    console.warn(`${logPrefix} ⚠ Source not found: ${srcPath}`);
    return false;
  }

  try {
    const stats = fs.lstatSync(srcPath); // 使用 lstatSync 以检测符号链接
    const itemName = path.basename(srcPath);

    // 如果是符号链接，解析它并复制实际的文件/目录
    if (stats.isSymbolicLink()) {
      const realPath = fs.realpathSync(srcPath);
      const realStats = fs.statSync(realPath);

      if (realStats.isDirectory()) {
        // 复制目录（跟随符号链接）
        execSync(`cp -RL "${realPath}" "${destPath}"`, { stdio: 'inherit' });
      } else {
        // 复制文件
        fs.copyFileSync(realPath, destPath);
      }
    } else if (stats.isDirectory()) {
      // 复制目录
      execSync(`cp -R "${srcPath}" "${destPath}"`, { stdio: 'inherit' });
    } else {
      // 复制文件
      fs.copyFileSync(srcPath, destPath);
    }
    console.log(`${logPrefix} ✓ Copied ${itemName}`);
    return true;
  } catch (err) {
    console.error(`${logPrefix} ✗ Error copying ${srcPath}: ${err.message}`);
    return false;
  }
}

/**
 * 复制文件并设置执行权限
 * @param {string} srcPath - 源文件路径
 * @param {string} destPath - 目标文件路径
 * @param {string} logPrefix - 日志前缀
 * @returns {boolean} 是否成功
 */
function copyExecutable(srcPath, destPath, logPrefix) {
  if (!fs.existsSync(srcPath)) {
    return false;
  }

  try {
    // 确保目标目录存在
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // 删除已存在的文件
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }

    // 复制文件
    fs.copyFileSync(srcPath, destPath);

    // 设置执行权限
    fs.chmodSync(destPath, 0o755);

    const fileName = path.basename(srcPath);
    console.log(`${logPrefix} ✓ Copied executable ${fileName}`);
    return true;
  } catch (err) {
    console.error(`${logPrefix} ✗ Error copying executable ${srcPath}: ${err.message}`);
    return false;
  }
}

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 删除目录（如果存在）
 * @param {string} dirPath - 目录路径
 * @param {string} logPrefix - 日志前缀（可选）
 */
function removeDirectory(dirPath, logPrefix) {
  if (fs.existsSync(dirPath)) {
    execSync(`rm -rf "${dirPath}"`, { stdio: 'inherit' });
    if (logPrefix) {
      console.log(`${logPrefix} Removed directory: ${path.basename(dirPath)}`);
    }
  }
}

/**
 * 删除文件（如果存在）
 * @param {string} filePath - 文件路径
 */
function removeFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

module.exports = {
  copyItem,
  copyExecutable,
  ensureDirectory,
  removeDirectory,
  removeFile,
};
