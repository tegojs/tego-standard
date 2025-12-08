const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { removeDirectory } = require('../utils/file-operations');
const { createLogPrefix, success, error, log } = require('../utils/logger');

/**
 * 检查 tego 是否存在
 */
function checkTegoExists(nodeModulesPath, logPrefix) {
  const tegoJsPath = path.join(nodeModulesPath, 'tego', 'bin', 'tego.js');
  const tegoBinPath = path.join(nodeModulesPath, '.bin', 'tego');
  const tegoPath = path.join(nodeModulesPath, 'tego');

  if (fs.existsSync(tegoJsPath)) return true;
  if (fs.existsSync(tegoBinPath)) return true;
  if (fs.existsSync(tegoPath)) return true;

  const pnpmPath = path.join(nodeModulesPath, '.pnpm');
  if (fs.existsSync(pnpmPath)) {
    try {
      const pnpmEntries = fs.readdirSync(pnpmPath);
      for (const entry of pnpmEntries) {
        if (entry.startsWith('tego@')) {
          const tegoPnpmPath = path.join(pnpmPath, entry, 'node_modules', 'tego');
          if (fs.existsSync(tegoPnpmPath)) {
            const tegoJsPnpmPath = path.join(tegoPnpmPath, 'bin', 'tego.js');
            if (fs.existsSync(tegoJsPnpmPath)) {
              log(logPrefix, `Found tego in .pnpm directory: ${tegoPnpmPath}`);
              return true;
            }
          }
        }
      }
    } catch (err) {
      // 忽略读取错误
    }
  }

  return false;
}

/**
 * 显式安装 tego
 */
function installTegoExplicitly(backendTemp, packageJsonPath, nodeModulesPath, logPrefix) {
  log(logPrefix, 'tego not found after install, attempting explicit installation...');

  try {
    const packageJsonAfter = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const tegoVersion = packageJsonAfter.dependencies?.tego || '1.6.0';
    log(logPrefix, `Installing tego@${tegoVersion} explicitly...`);

    if (fs.existsSync(nodeModulesPath)) {
      log(logPrefix, 'Cleaning node_modules to avoid dependency type conflicts...');
      removeDirectory(nodeModulesPath, logPrefix);
    }

    const { temporarilyRemoveWorkspaceYaml, restoreWorkspaceYaml, createNpmrc } = require('./dependency-installer');
    const { workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath } = temporarilyRemoveWorkspaceYaml(
      backendTemp,
      logPrefix,
    );

    createNpmrc(backendTemp, logPrefix);

    try {
      const lockFilePath = path.join(backendTemp, 'pnpm-lock.yaml');
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
        log(logPrefix, 'Removed pnpm-lock.yaml to avoid dependency type conflicts');
      }

      log(logPrefix, `Installing tego@${tegoVersion} using pnpm add...`);
      // 使用 --no-lockfile 避免创建或修改 lockfile
      const installEnv = {
        ...process.env,
        NODE_ENV: 'production',
        // 禁用 lockfile，避免修改项目根目录的 pnpm-lock.yaml
        PNPM_LOCKFILE: 'false',
      };

      execSync(`pnpm add tego@${tegoVersion} --save-prod --ignore-scripts --ignore-workspace --no-lockfile`, {
        cwd: backendTemp,
        stdio: 'inherit',
        env: installEnv,
      });

      success(logPrefix, 'tego installed successfully');
    } finally {
      restoreWorkspaceYaml(workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath, logPrefix);
    }

    if (!checkTegoExists(nodeModulesPath, logPrefix)) {
      error(logPrefix, 'tego package still not found after explicit installation');
      error(logPrefix, `Expected tego.js at: ${path.join(nodeModulesPath, 'tego', 'bin', 'tego.js')}`);
      process.exit(1);
    }
  } catch (err) {
    error(logPrefix, `Failed to install tego explicitly: ${err.message}`);
    process.exit(1);
  }
}

/**
 * 验证 tego 安装
 */
function verifyTegoInstallation(backendTemp, packageJsonPath, logPrefix) {
  const nodeModulesPath = path.join(backendTemp, 'node_modules');

  if (!checkTegoExists(nodeModulesPath, logPrefix)) {
    installTegoExplicitly(backendTemp, packageJsonPath, nodeModulesPath, logPrefix);
  }

  if (!checkTegoExists(nodeModulesPath, logPrefix)) {
    error(logPrefix, 'tego package verification failed');
    process.exit(1);
  }

  success(logPrefix, 'tego package verified');
}

module.exports = {
  checkTegoExists,
  verifyTegoInstallation,
};
