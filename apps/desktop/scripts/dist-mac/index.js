#!/usr/bin/env node

/**
 * macOS 打包脚本
 * 完整的 macOS 应用打包流程
 */

const path = require('path');
const fs = require('fs');
const { getDesktopDir } = require('../utils/paths');
const { detectAppName } = require('../utils/app-detector');
const { createLogPrefix, title, success, error } = require('../utils/logger');
const { createTaskList, createCommandTask, runTasks } = require('../utils/task-runner');
const { ensureNodeInPath } = require('../utils/node-finder');
const { verifyDependencies } = require('./dependency-checker');
const { checkFileDescriptorLimit } = require('./file-descriptor-checker');
const { prepareTsconfigPaths, verifyWebBuild } = require('./web-build-verifier');
const { verifySqlite3NativeModule } = require('./sqlite3-verifier');
const { backupWorkspaceYaml, restoreWorkspaceYaml } = require('../utils/workspace-protector');

const logPrefix = createLogPrefix('dist-mac');
const desktopDir = getDesktopDir();

/**
 * 创建 macOS 打包任务列表
 */
function createDistMacTasks() {
  return createTaskList([
    {
      title: 'Backing up pnpm-workspace.yaml',
      task: async () => {
        backupWorkspaceYaml();
      },
    },
    {
      title: 'Checking file descriptor limit',
      task: async () => {
        checkFileDescriptorLimit();
      },
    },
    {
      title: 'Verifying dependencies',
      task: async () => {
        verifyDependencies();
      },
    },
    {
      title: 'Preparing tsconfig paths',
      task: async () => {
        prepareTsconfigPaths();
      },
    },
    {
      title: 'Verifying web build',
      task: async () => {
        verifyWebBuild();
      },
    },
    createCommandTask('Building web application', 'node scripts/commands/build-web.js', {
      cwd: desktopDir,
      silent: false,
    }),
    createCommandTask('Building desktop application', 'node scripts/commands/build.js', {
      cwd: desktopDir,
      silent: false,
      env: {
        NODE_ENV: 'production',
      },
    }),
    createCommandTask('Preparing backend', 'node scripts/prepare-backend/index.js', {
      cwd: desktopDir,
      silent: false,
    }),
    {
      title: 'Verifying backend preparation',
      task: async () => {
        const backendTempPath = path.join(desktopDir, 'backend-temp');
        if (!fs.existsSync(backendTempPath)) {
          throw new Error(`Backend temp directory not found at ${backendTempPath}`);
        }
      },
    },
    createCommandTask(
      'Packaging with electron-builder',
      'npx electron-builder --mac dmg --config electron-builder.config.js --config.npmRebuild=false',
      {
        cwd: desktopDir,
        silent: false,
        env: {
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
          PATH: ensureNodeInPath(),
        },
      },
    ),
    createCommandTask('Copying node executable', 'node scripts/copy-node-executable.js', {
      cwd: desktopDir,
      silent: false,
    }),
    {
      title: 'Verifying sqlite3 native module',
      task: async () => {
        const appName = detectAppName();
        if (!verifySqlite3NativeModule(appName)) {
          throw new Error('sqlite3 native module missing');
        }
      },
    },
    createCommandTask('Creating DMG', 'node scripts/create-dmg.js', {
      cwd: desktopDir,
      silent: false,
    }),
    createCommandTask('Cleaning up backend', 'node scripts/cleanup-backend.js', {
      cwd: desktopDir,
      silent: false,
    }),
    {
      title: 'Restoring pnpm-workspace.yaml',
      task: async () => {
        restoreWorkspaceYaml();
      },
    },
  ]);
}

async function main() {
  title('Building macOS Distribution Package');

  const tasks = createDistMacTasks();
  const result = await runTasks(tasks);

  if (result) {
    success(logPrefix, 'All steps completed successfully');
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
