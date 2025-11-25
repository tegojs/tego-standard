#!/usr/bin/env node

const path = require('path');
const { execSync } = require('child_process');
const { getDesktopDir } = require('./utils/paths');
const { createLogPrefix, step, success, error } = require('./utils/logger');

const logPrefix = createLogPrefix('dist-mac');
const desktopDir = getDesktopDir();

/**
 * 执行构建步骤
 * @param {string} name - 步骤名称
 * @param {string} command - 命令
 * @param {object} options - 选项
 */
function runStep(name, command, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  step(logPrefix, name);
  execSync(command, {
    stdio: 'inherit',
    cwd: desktopDir,
    env,
    shell: process.platform === 'win32' ? process.env.ComSpec : undefined,
  });
}

try {
  // 准备后端：在临时目录执行 pnpm install --prod
  // electron-builder 会通过 extraResources 自动包含 backend-temp
  runStep('prepare-backend', 'node scripts/prepare-backend.js');

  // electron-builder 会自动处理文件包含和打包
  // web-dist 直接从 ../web/dist 通过 extraResources 包含，无需准备步骤
  runStep('electron-builder', 'electron-builder --mac dmg --config.npmRebuild=false', {
    env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  });

  // 复制 node 可执行文件到应用包
  runStep('copy-node-executable', 'node scripts/copy-node-executable.js');

  // 创建 DMG 安装包
  runStep('create-dmg', 'node scripts/create-dmg.js');

  // 清理临时目录
  runStep('cleanup-backend', 'node scripts/cleanup-backend.js');

  success(logPrefix, 'All steps completed successfully');
} catch (err) {
  error(logPrefix, 'Build failed');
  console.error(err.message || err);
  process.exit(err.status || 1);
}
