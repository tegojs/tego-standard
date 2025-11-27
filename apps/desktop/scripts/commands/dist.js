#!/usr/bin/env node

/**
 * 构建生产版本（所有平台）
 * 包括构建 desktop、web、准备后端、打包和清理
 */

const { getDesktopDir } = require('../utils/paths');
const { createLogPrefix, title, success, error } = require('../utils/logger');
const { createTaskList, createCommandTask, runTasks } = require('../utils/task-runner');

const logPrefix = createLogPrefix('dist');
const desktopDir = getDesktopDir();

async function main() {
  title('Building Distribution Package');

  const tasks = createTaskList([
    createCommandTask('Building desktop application', 'pnpm build', {
      cwd: desktopDir,
      silent: false,
    }),
    createCommandTask('Building web application', 'node scripts/commands/build-web.js', {
      cwd: desktopDir,
      silent: false,
    }),
    createCommandTask('Preparing backend', 'node scripts/prepare-backend/index.js', {
      cwd: desktopDir,
      silent: false,
    }),
    createCommandTask(
      'Packaging with electron-builder',
      'cross-env ELECTRON_SKIP_BINARY_DOWNLOAD=1 electron-builder --config.npmRebuild=false',
      {
        cwd: desktopDir,
        silent: false,
        env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
      },
    ),
    createCommandTask('Cleaning up', 'node scripts/cleanup-backend.js', {
      cwd: desktopDir,
      silent: false,
    }),
  ]);

  const result = await runTasks(tasks);

  if (result) {
    success(logPrefix, 'Distribution build completed successfully');
    process.exit(0);
  } else {
    error(logPrefix, 'Distribution build failed');
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  process.exit(1);
});
