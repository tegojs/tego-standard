#!/usr/bin/env node

/**
 * macOS 打包脚本
 * 完整的 macOS 应用打包流程
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
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
const { verifyArtifacts, printVerificationResults } = require('../utils/artifact-verifier');

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
          // 配置缓存环境变量，加速构建
          // electron-builder 会自动使用这些缓存目录
          ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(os.homedir(), '.cache', 'electron'),
          ELECTRON_BUILDER_CACHE:
            process.env.ELECTRON_BUILDER_CACHE || path.join(os.homedir(), '.cache', 'electron-builder'),
        },
      },
    ),
    // Note: Node executable is now copied automatically via afterPack hook in electron-builder.config.js
    {
      title: 'Verifying sqlite3 native module',
      task: async () => {
        const appName = detectAppName();
        const { getBuiltArchitectures } = require('../utils/paths');
        const architectures = getBuiltArchitectures(desktopDir, appName);

        if (architectures.length === 0) {
          throw new Error('No built architectures found. Build may have failed.');
        }

        // 验证每个架构的 sqlite3 模块
        for (const arch of architectures) {
          console.log(`${logPrefix} Verifying sqlite3 for ${arch} architecture...`);
          // 注意：verifySqlite3NativeModule 需要更新以支持架构参数
          // 目前先验证第一个架构（向后兼容）
          if (!verifySqlite3NativeModule(appName)) {
            throw new Error(`sqlite3 native module missing for ${arch} architecture`);
          }
        }

        success(logPrefix, `Verified sqlite3 for ${architectures.length} architecture(s): ${architectures.join(', ')}`);
      },
    },
    {
      title: 'Verifying all artifacts',
      task: async () => {
        const appName = detectAppName();
        const { getBuiltArchitectures } = require('../utils/paths');
        const architectures = getBuiltArchitectures(desktopDir, appName);

        if (architectures.length === 0) {
          throw new Error('No built architectures found. Build may have failed.');
        }

        // 验证每个架构的构建产物
        for (const arch of architectures) {
          console.log(`${logPrefix} Verifying artifacts for ${arch} architecture...`);
          const results = verifyArtifacts({ appName, strict: false, arch });
          printVerificationResults(results);
          if (!results.allValid) {
            throw new Error(`Artifact verification failed for ${arch} architecture. See details above.`);
          }
        }

        success(
          logPrefix,
          `Verified artifacts for ${architectures.length} architecture(s): ${architectures.join(', ')}`,
        );
      },
    },
    // Note: DMG is now created automatically by electron-builder (see electron-builder.config.js dmg config)
    // Note: Backend cleanup is now handled by afterAllArtifactBuild hook in electron-builder.config.js
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

  let buildSucceeded = false;
  let buildError = null;

  try {
    const tasks = createDistMacTasks();
    const result = await runTasks(tasks);

    if (result) {
      buildSucceeded = true;
      success(logPrefix, 'All steps completed successfully');
    } else {
      error(logPrefix, 'Build failed');
    }
  } catch (err) {
    buildError = err;
    error(logPrefix, `Build error: ${err.message || err}`);
  } finally {
    // 确保无论构建成功还是失败，都要恢复 pnpm-workspace.yaml
    try {
      restoreWorkspaceYaml();
    } catch (restoreErr) {
      error(logPrefix, `Failed to restore pnpm-workspace.yaml: ${restoreErr.message}`);
    }

    // 如果构建失败，记录错误信息
    if (buildError) {
      error(logPrefix, `Build failed with error: ${buildError.message || buildError}`);
      if (buildError.stack) {
        console.error(buildError.stack);
      }
    }
  }

  // 根据构建结果退出
  if (buildSucceeded) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  // 确保在最终错误时也尝试恢复
  try {
    restoreWorkspaceYaml();
  } catch (restoreErr) {
    error(logPrefix, `Failed to restore pnpm-workspace.yaml in error handler: ${restoreErr.message}`);
  }
  process.exit(1);
});
