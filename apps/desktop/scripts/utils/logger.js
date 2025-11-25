#!/usr/bin/env node

/**
 * 日志工具
 * 提供统一的日志格式
 */

/**
 * 创建日志前缀
 * @param {string} scriptName - 脚本名称
 */
function createLogPrefix(scriptName) {
  return `[${scriptName}]`;
}

/**
 * 记录信息
 */
function log(prefix, message) {
  console.log(`${prefix} ${message}`);
}

/**
 * 记录成功信息
 */
function success(prefix, message) {
  console.log(`${prefix} ✓ ${message}`);
}

/**
 * 记录警告信息
 */
function warn(prefix, message) {
  console.warn(`${prefix} ⚠ ${message}`);
}

/**
 * 记录错误信息
 */
function error(prefix, message) {
  console.error(`${prefix} ✗ ${message}`);
}

/**
 * 记录步骤开始
 */
function step(prefix, stepName) {
  console.log(`${prefix} ===== ${stepName} =====`);
}

module.exports = {
  createLogPrefix,
  log,
  success,
  warn,
  error,
  step,
};
