const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogPrefix, success, error, log } = require('../utils/logger');

/**
 * 临时移除 pnpm-workspace.yaml
 */
function temporarilyRemoveWorkspaceYaml(backendTemp, logPrefix) {
  const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
  const workspaceYamlBackup = path.join(backendTemp, 'pnpm-workspace.yaml.backup');
  let workspaceYamlExists = false;

  if (fs.existsSync(workspaceYamlPath)) {
    fs.renameSync(workspaceYamlPath, workspaceYamlBackup);
    workspaceYamlExists = true;
    log(logPrefix, 'Temporarily removed pnpm-workspace.yaml to avoid workspace conflicts');
  }

  return { workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath };
}

/**
 * 恢复 pnpm-workspace.yaml
 */
function restoreWorkspaceYaml(workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath, logPrefix) {
  if (workspaceYamlExists && fs.existsSync(workspaceYamlBackup)) {
    fs.renameSync(workspaceYamlBackup, workspaceYamlPath);
    log(logPrefix, 'Restored pnpm-workspace.yaml');
  }
}

/**
 * 创建 .npmrc 文件
 */
function createNpmrc(backendTemp, logPrefix) {
  const npmrcPath = path.join(backendTemp, '.npmrc');
  // 配置 .npmrc：
  // - node-linker=hoisted: 使用提升的 node_modules 结构
  // - link-workspace-packages=false: 不链接 workspace 包
  // - lockfile=false: 禁用 lockfile，避免创建或修改 pnpm-lock.yaml
  fs.writeFileSync(npmrcPath, 'node-linker=hoisted\nlink-workspace-packages=false\nlockfile=false\n', 'utf8');
  log(logPrefix, 'Created .npmrc with node-linker=hoisted, link-workspace-packages=false, and lockfile=false');
}

/**
 * 安装生产依赖
 */
function installProductionDependencies(backendTemp, packageJsonPath, logPrefix) {
  log(logPrefix, 'Installing production dependencies with pnpm...');

  try {
    // 验证 package.json 中是否包含 tego
    const packageJsonAfter = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (!packageJsonAfter.dependencies?.tego) {
      error(logPrefix, 'tego was not added to dependencies correctly');
      error(logPrefix, `Current dependencies: ${JSON.stringify(packageJsonAfter.dependencies || {}, null, 2)}`);
      process.exit(1);
    }
    log(logPrefix, `Verified tego in dependencies: ${packageJsonAfter.dependencies.tego}`);

    const { workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath } = temporarilyRemoveWorkspaceYaml(
      backendTemp,
      logPrefix,
    );

    createNpmrc(backendTemp, logPrefix);

    try {
      // 使用 --no-lockfile 避免创建或修改 lockfile
      // 设置环境变量确保 pnpm 不会向上查找 workspace 和 lockfile
      const installEnv = {
        ...process.env,
        NODE_ENV: 'production',
        // 禁用 lockfile，避免修改项目根目录的 pnpm-lock.yaml
        PNPM_LOCKFILE: 'false',
      };

      execSync('pnpm install --prod --ignore-scripts --ignore-workspace --no-lockfile', {
        cwd: backendTemp,
        stdio: 'inherit',
        env: installEnv,
      });
      success(logPrefix, 'Dependencies installed successfully');
    } finally {
      restoreWorkspaceYaml(workspaceYamlExists, workspaceYamlBackup, workspaceYamlPath, logPrefix);
    }
  } catch (err) {
    error(logPrefix, `Failed to install dependencies: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  installProductionDependencies,
  temporarilyRemoveWorkspaceYaml,
  restoreWorkspaceYaml,
  createNpmrc,
};
