#!/usr/bin/env node

/**
 * 开发模式启动脚本
 * 启动 web 开发服务器、后端服务器和 Electron 应用
 */

const { execSync } = require('child_process');
const { getProjectRoot, getDesktopDir } = require('../utils/paths');
const { createLogPrefix, title, log, success, error, info } = require('../utils/logger');
const { createTaskList, createCommandTask, runTasks } = require('../utils/task-runner');

const logPrefix = createLogPrefix('dev');
const projectRoot = getProjectRoot();
const desktopDir = getDesktopDir();

// 从环境变量获取端口，默认值
const webPort = process.env.WEB_PORT || process.env.PORT || '31000';
const appPort = process.env.APP_PORT || '3000';

async function main() {
  title('Starting Development Mode');

  // 步骤 1-2: 检查端口和构建
  const prepTasks = createTaskList([
    createCommandTask('Checking port availability', 'node scripts/check-port.js', {
      cwd: desktopDir,
      silent: false,
    }),
    createCommandTask('Building desktop application', 'pnpm build', {
      cwd: desktopDir,
      silent: false,
    }),
  ]);

  const prepSuccess = await runTasks(prepTasks);
  if (!prepSuccess) {
    error(logPrefix, 'Preparation failed');
    process.exit(1);
  }

  // 步骤 3: 启动所有服务（使用 concurrently）
  log(logPrefix, 'Starting development servers...');
  info(logPrefix, `Web port: ${webPort}, App port: ${appPort}`);

  const webDevCmd = `cd ../.. && cross-env PORT=${webPort} WEB_PORT=${webPort} APP_PORT=${appPort} pnpm exec -- rsbuild dev --open --config rsbuild.config.ts --root apps/web`;
  const serverCmd = `cd ../.. && cross-env APP_PORT=${appPort} pnpm dev-server`;
  const electronCmd = `wait-on http-get://localhost:${webPort} && cross-env NODE_ENV=development WEB_PORT=${webPort} pnpm electron:dev`;

  try {
    // 使用 execSync 执行 concurrently，保持与原命令一致的行为
    execSync(`concurrently "${webDevCmd}" "${serverCmd}" "${electronCmd}"`, {
      cwd: desktopDir,
      stdio: 'inherit',
      shell: true,
    });
  } catch (err) {
    // concurrently 被 Ctrl+C 中断时也会抛出错误，这是正常的
    if (err.signal === 'SIGINT') {
      log(logPrefix, 'Development servers stopped');
      process.exit(0);
    }
    error(logPrefix, 'Failed to start development mode');
    error(logPrefix, err.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  process.exit(1);
});
