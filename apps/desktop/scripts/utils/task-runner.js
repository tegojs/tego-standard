#!/usr/bin/env node

/**
 * 任务运行器
 * 使用 listr 和 ora 提供更好的任务执行体验
 */

const Listr = require('listr');
const { execSync } = require('child_process');
const { getDesktopDir } = require('./paths');
const chalk = require('chalk');

/**
 * 创建任务列表
 * @param {Array<Object>} tasks - 任务列表
 * @param {Object} options - 选项
 */
function createTaskList(tasks, options = {}) {
  return new Listr(tasks, {
    concurrent: options.concurrent || false,
    exitOnError: options.exitOnError !== false,
    renderer: process.stdout.isTTY ? 'default' : 'verbose',
    ...options,
  });
}

/**
 * 创建执行命令的任务
 * @param {string} title - 任务标题
 * @param {string|Function} command - 命令或命令生成函数
 * @param {Object} options - 选项
 */
function createCommandTask(title, command, options = {}) {
  return {
    title: chalk.bold(title),
    task: async (ctx, task) => {
      const desktopDir = getDesktopDir();
      const cmd = typeof command === 'function' ? command(ctx) : command;

      try {
        execSync(cmd, {
          cwd: options.cwd || desktopDir,
          stdio: options.silent ? 'pipe' : 'inherit',
          env: { ...process.env, ...options.env },
          ...options,
        });
        task.title = `${chalk.green('✓')} ${title}`;
      } catch (err) {
        task.title = `${chalk.red('✗')} ${title}`;
        throw new Error(err.message || err);
      }
    },
  };
}

/**
 * 创建条件任务
 * @param {string} title - 任务标题
 * @param {Function} condition - 条件函数
 * @param {Object} task - 任务对象
 */
function createConditionalTask(title, condition, task) {
  return {
    title: chalk.bold(title),
    task: async (ctx) => {
      if (await condition(ctx)) {
        return task;
      }
      return {
        title: `${chalk.gray('⊘')} ${title} ${chalk.gray('(skipped)')}`,
        task: () => {},
      };
    },
  };
}

/**
 * 执行任务列表
 * @param {Listr} taskList - 任务列表
 */
async function runTasks(taskList) {
  try {
    await taskList.run();
    return true;
  } catch (err) {
    console.error(chalk.red(`\n✗ Task failed: ${err.message}`));
    return false;
  }
}

module.exports = {
  createTaskList,
  createCommandTask,
  createConditionalTask,
  runTasks,
};
