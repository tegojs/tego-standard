#!/usr/bin/env node

/**
 * 打包应用（不创建安装包，只创建目录）
 * 用于测试打包结果
 */

const { getDesktopDir } = require('../utils/paths');
const { createLogPrefix, title, success, error } = require('../utils/logger');
const { createTaskList, createCommandTask, runTasks } = require('../utils/task-runner');

const logPrefix = createLogPrefix('pack');
const desktopDir = getDesktopDir();

async function main() {
  title('Packing Application (Directory Mode)');

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
      'Packaging with electron-builder (directory mode)',
      'cross-env ELECTRON_SKIP_BINARY_DOWNLOAD=1 electron-builder --dir --config.npmRebuild=false',
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
    success(logPrefix, 'Pack completed successfully');
    process.exit(0);
  } else {
    error(logPrefix, 'Pack failed');
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  process.exit(1);
});
