#!/usr/bin/env node

/**
 * 构建 Web 应用
 * 在项目根目录执行 pnpm build @tego/web
 */

const { getProjectRoot } = require('../utils/paths');
const { createLogPrefix, title, success, error } = require('../utils/logger');
const { createTaskList, createCommandTask, runTasks } = require('../utils/task-runner');

const logPrefix = createLogPrefix('build-web');
const projectRoot = getProjectRoot();

async function main() {
  title('Building Web Application');

  const tasks = createTaskList([
    createCommandTask('Building @tego/web', 'pnpm build @tego/web', {
      cwd: projectRoot,
      silent: false,
    }),
  ]);

  const result = await runTasks(tasks);

  if (result) {
    success(logPrefix, 'Web build completed');
    process.exit(0);
  } else {
    error(logPrefix, 'Web build failed');
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  process.exit(1);
});
