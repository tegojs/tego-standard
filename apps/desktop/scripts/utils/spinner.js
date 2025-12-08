#!/usr/bin/env node

/**
 * 加载动画工具
 * 使用 ora 提供加载动画
 */

const ora = require('ora');
const chalk = require('chalk');

/**
 * 创建加载动画
 * @param {string} text - 加载文本
 * @param {string} color - 颜色
 */
function createSpinner(text, color = 'blue') {
  return ora({
    text: chalk[color](text),
    spinner: 'dots',
  });
}

/**
 * 执行带加载动画的任务
 * @param {string} text - 加载文本
 * @param {Function} task - 任务函数
 * @param {Object} options - 选项
 */
async function withSpinner(text, task, options = {}) {
  const spinner = createSpinner(text, options.color);

  try {
    spinner.start();
    const result = await task();
    spinner.succeed(chalk.green(`${text} completed`));
    return result;
  } catch (err) {
    spinner.fail(chalk.red(`${text} failed: ${err.message || err}`));
    throw err;
  }
}

/**
 * 执行同步命令带加载动画
 * @param {string} text - 加载文本
 * @param {Function} task - 同步任务函数
 * @param {Object} options - 选项
 */
function withSpinnerSync(text, task, options = {}) {
  const spinner = createSpinner(text, options.color);

  try {
    spinner.start();
    const result = task();
    spinner.succeed(chalk.green(`${text} completed`));
    return result;
  } catch (err) {
    spinner.fail(chalk.red(`${text} failed: ${err.message || err}`));
    throw err;
  }
}

module.exports = {
  createSpinner,
  withSpinner,
  withSpinnerSync,
};
