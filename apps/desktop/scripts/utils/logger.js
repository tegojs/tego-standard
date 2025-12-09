#!/usr/bin/env node

/**
 * 日志工具
 * 使用 chalk 美化输出，提供统一的日志格式
 */

const chalk = require('chalk');

/**
 * 创建日志前缀
 * @param {string} scriptName - 脚本名称
 */
function createLogPrefix(scriptName) {
  return chalk.blue(`[${scriptName}]`);
}

/**
 * 记录信息
 */
function log(prefix, message) {
  console.log(`${prefix} ${chalk.gray(message)}`);
}

/**
 * 记录成功信息
 */
function success(prefix, message) {
  console.log(`${prefix} ${chalk.green('✓')} ${chalk.green(message)}`);
}

/**
 * 记录警告信息
 */
function warn(prefix, message) {
  console.warn(`${prefix} ${chalk.yellow('⚠')} ${chalk.yellow(message)}`);
}

/**
 * 记录错误信息
 */
function error(prefix, message) {
  console.error(`${prefix} ${chalk.red('✗')} ${chalk.red(message)}`);
}

/**
 * 记录步骤开始
 */
function step(prefix, stepName) {
  console.log(`${prefix} ${chalk.cyan('=====')} ${chalk.bold(stepName)} ${chalk.cyan('=====')}`);
}

/**
 * 记录标题
 */
function title(message) {
  console.log(chalk.bold.cyan(`\n${'='.repeat(60)}`));
  console.log(chalk.bold.cyan(`  ${message}`));
  console.log(chalk.bold.cyan(`${'='.repeat(60)}\n`));
}

/**
 * 记录信息（带颜色）
 */
function info(prefix, message) {
  console.log(`${prefix} ${chalk.blue('ℹ')} ${chalk.blue(message)}`);
}

module.exports = {
  createLogPrefix,
  log,
  success,
  warn,
  error,
  step,
  title,
  info,
};
