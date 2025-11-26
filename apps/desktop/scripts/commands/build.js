#!/usr/bin/env node

/**
 * Desktop 应用构建脚本
 * 负责编译 TypeScript 代码和复制资源文件
 */

const path = require('path');
const { getProjectRoot, getDesktopDir } = require('../utils/paths');
const { createLogPrefix, title, success, error } = require('../utils/logger');
const { createTaskList, createCommandTask, runTasks } = require('../utils/task-runner');

const logPrefix = createLogPrefix('build');
const projectRoot = getProjectRoot();
const desktopDir = getDesktopDir();
const tsconfigPath = path.join(desktopDir, 'electron', 'tsconfig.json');

async function main() {
  title('Building Desktop Application');

  const tasks = createTaskList([
    createCommandTask('Compiling TypeScript', `pnpm exec tsc -p apps/desktop/electron/tsconfig.json --skipLibCheck`, {
      cwd: projectRoot,
      silent: false,
    }),
    createCommandTask('Copying assets', 'node scripts/copy-assets.js', {
      cwd: desktopDir,
      silent: false,
    }),
  ]);

  const result = await runTasks(tasks);

  if (result) {
    success(logPrefix, 'Build completed successfully');
    process.exit(0);
  } else {
    error(logPrefix, 'Build failed');
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  process.exit(1);
});
