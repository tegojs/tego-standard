const { execSync } = require('child_process');
const { getDesktopDir } = require('../utils/paths');
const { createLogPrefix, step } = require('../utils/logger');

const logPrefix = createLogPrefix('dist-mac');
const desktopDir = getDesktopDir();

/**
 * 执行构建步骤
 */
function runStep(name, command, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  step(logPrefix, name);
  execSync(command, {
    stdio: 'inherit',
    cwd: options.cwd || desktopDir,
    env,
    shell: process.platform === 'win32' ? process.env.ComSpec : undefined,
  });
}

module.exports = {
  runStep,
};
