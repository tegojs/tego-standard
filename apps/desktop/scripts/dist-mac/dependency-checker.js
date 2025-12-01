const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getProjectRoot } = require('../utils/paths');
const { getDesktopDir } = require('../utils/paths');
const { createLogPrefix, success, error, log } = require('../utils/logger');

const logPrefix = createLogPrefix('dist-mac');
const projectRoot = getProjectRoot();
const desktopDir = getDesktopDir();

/**
 * 检查依赖是否已安装
 */
function checkDependencies() {
  const rootNodeModules = path.join(projectRoot, 'node_modules', 'typescript');
  const desktopNodeModules = path.join(desktopDir, 'node_modules', 'typescript');

  if (fs.existsSync(rootNodeModules)) {
    return true;
  }

  if (fs.existsSync(desktopNodeModules)) {
    return true;
  }

  try {
    const tscPath = path.join(
      projectRoot,
      'node_modules',
      '.pnpm',
      'typescript@5.8.3',
      'node_modules',
      'typescript',
      'bin',
      'tsc',
    );
    if (fs.existsSync(tscPath)) {
      execSync(`node "${tscPath}" --version`, {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      return true;
    }
  } catch {
    // 忽略错误
  }

  return false;
}

/**
 * 验证依赖
 */
function verifyDependencies() {
  log(logPrefix, 'Checking dependencies...');
  if (!checkDependencies()) {
    error(logPrefix, 'Dependencies not found. Please install dependencies first.');
    error(logPrefix, 'Run: pnpm install (from project root)');
    error(logPrefix, 'Or: cd ../.. && pnpm install');
    process.exit(1);
  } else {
    success(logPrefix, 'Dependencies found');
  }
}

module.exports = {
  verifyDependencies,
};
