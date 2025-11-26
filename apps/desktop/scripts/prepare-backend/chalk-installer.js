const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogPrefix, log } = require('../utils/logger');
const { temporarilyRemoveWorkspaceYaml, restoreWorkspaceYaml } = require('./dependency-installer');

/**
 * 检查并安装 chalk（如果需要）
 */
function checkAndInstallChalk(backendTemp, logPrefix) {
  const nodeModulesPath = path.join(backendTemp, 'node_modules');
  const chalkPath = path.join(nodeModulesPath, 'chalk');

  if (!fs.existsSync(chalkPath)) {
    log(logPrefix, 'chalk not found, installing...');
    try {
      const { workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath } = temporarilyRemoveWorkspaceYaml(
        backendTemp,
        logPrefix,
      );

      try {
        execSync('pnpm add chalk --save-prod --ignore-scripts', {
          cwd: backendTemp,
          stdio: 'inherit',
          env: { ...process.env, NODE_ENV: 'production' },
        });
      } finally {
        restoreWorkspaceYaml(workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath, logPrefix);
      }
    } catch (err) {
      log(logPrefix, `Warning: Could not install chalk: ${err.message}`);
    }
  }
}

module.exports = {
  checkAndInstallChalk,
};
