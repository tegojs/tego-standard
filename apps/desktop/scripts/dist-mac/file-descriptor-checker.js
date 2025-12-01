const { execSync } = require('child_process');
const { createLogPrefix, warn, log } = require('../utils/logger');

const logPrefix = createLogPrefix('dist-mac');

/**
 * 检查并提示文件描述符限制
 */
function checkFileDescriptorLimit() {
  try {
    const ulimitOutput = execSync('ulimit -n', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const currentLimit = parseInt(ulimitOutput, 10);

    if (currentLimit < 1024) {
      warn(logPrefix, `Current file descriptor limit is ${currentLimit}, which may be too low for large builds.`);
      warn(logPrefix, 'To increase the limit, run: ulimit -n 1024');
      warn(logPrefix, 'Or add to ~/.zshrc: ulimit -n 1024');
      warn(logPrefix, 'Then restart your terminal or run: source ~/.zshrc');
    } else {
      log(logPrefix, `File descriptor limit: ${currentLimit} (OK)`);
    }
  } catch (e) {
    log(logPrefix, 'Could not check file descriptor limit', 'warn');
  }
}

module.exports = {
  checkFileDescriptorLimit,
};
