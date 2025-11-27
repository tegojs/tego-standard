#!/usr/bin/env node

/**
 * 临时文件管理器
 * 统一管理构建过程中的临时目录
 */

const fs = require('fs');
const path = require('path');
const { getDesktopDir } = require('./paths');
const { ensureDirectory, removeDirectory } = require('./file-operations');
const { createLogPrefix, log, success } = require('./logger');

const logPrefix = createLogPrefix('temp-manager');
const desktopDir = getDesktopDir();

/**
 * 统一的临时目录根路径
 */
const TEMP_ROOT = path.join(desktopDir, '.build-temp');

/**
 * 临时目录结构
 */
const TEMP_DIRS = {
  ROOT: TEMP_ROOT,
  BACKEND: path.join(TEMP_ROOT, 'backend'),
  DMG: path.join(TEMP_ROOT, 'dmg'),
};

/**
 * 确保临时目录存在
 * @param {string} dirPath - 目录路径
 * @returns {string} 目录路径
 */
function ensureTempDir(dirPath) {
  ensureDirectory(dirPath);
  return dirPath;
}

/**
 * 获取临时目录路径
 * @param {string} name - 目录名称（'backend' | 'dmg'）
 * @returns {string} 目录路径
 */
function getTempDir(name) {
  switch (name) {
    case 'backend':
      return ensureTempDir(TEMP_DIRS.BACKEND);
    case 'dmg':
      return ensureTempDir(TEMP_DIRS.DMG);
    default:
      throw new Error(`Unknown temp directory name: ${name}`);
  }
}

/**
 * 清理所有临时目录
 */
function cleanupAllTempDirs() {
  log(logPrefix, 'Cleaning up all temporary directories...');

  if (fs.existsSync(TEMP_ROOT)) {
    removeDirectory(TEMP_ROOT, logPrefix);
    success(logPrefix, 'Cleaned up all temporary directories');
  } else {
    log(logPrefix, 'No temporary directories to clean up');
  }
}

/**
 * 清理指定的临时目录
 * @param {string} name - 目录名称（'backend' | 'dmg'）
 */
function cleanupTempDir(name) {
  const dirPath = getTempDir(name);
  if (fs.existsSync(dirPath)) {
    removeDirectory(dirPath, logPrefix);
    success(logPrefix, `Cleaned up ${name} temporary directory`);
  } else {
    log(logPrefix, `${name} temporary directory does not exist, skipping cleanup`);
  }
}

/**
 * 初始化临时目录结构
 */
function initTempDirs() {
  log(logPrefix, 'Initializing temporary directory structure...');
  ensureTempDir(TEMP_DIRS.BACKEND);
  ensureTempDir(TEMP_DIRS.DMG);
  success(logPrefix, 'Temporary directory structure initialized');
}

module.exports = {
  TEMP_DIRS,
  getTempDir,
  ensureTempDir,
  cleanupAllTempDirs,
  cleanupTempDir,
  initTempDirs,
};
