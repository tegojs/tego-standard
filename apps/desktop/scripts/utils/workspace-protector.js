#!/usr/bin/env node

/**
 * 保护 pnpm-workspace.yaml 不被自动修改
 * 在构建前备份，构建后恢复
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./paths');
const { createLogPrefix, log } = require('./logger');

const logPrefix = createLogPrefix('workspace-protector');
const projectRoot = getProjectRoot();
const workspaceYamlPath = path.join(projectRoot, 'pnpm-workspace.yaml');
const workspaceYamlBackupPath = path.join(projectRoot, 'pnpm-workspace.yaml.backup');

/**
 * 备份 pnpm-workspace.yaml
 */
function backupWorkspaceYaml() {
  if (!fs.existsSync(workspaceYamlPath)) {
    log(logPrefix, 'pnpm-workspace.yaml not found, skipping backup');
    return false;
  }

  try {
    const content = fs.readFileSync(workspaceYamlPath, 'utf8');
    fs.writeFileSync(workspaceYamlBackupPath, content, 'utf8');
    log(logPrefix, 'Backed up pnpm-workspace.yaml');
    return true;
  } catch (err) {
    log(logPrefix, `Failed to backup pnpm-workspace.yaml: ${err.message}`, 'warn');
    return false;
  }
}

/**
 * 恢复 pnpm-workspace.yaml
 */
function restoreWorkspaceYaml() {
  if (!fs.existsSync(workspaceYamlBackupPath)) {
    log(logPrefix, 'Backup file not found, skipping restore');
    return false;
  }

  try {
    const backupContent = fs.readFileSync(workspaceYamlBackupPath, 'utf8');
    const currentContent = fs.existsSync(workspaceYamlPath) ? fs.readFileSync(workspaceYamlPath, 'utf8') : '';

    // 只有在文件被修改时才恢复
    if (backupContent !== currentContent) {
      fs.writeFileSync(workspaceYamlPath, backupContent, 'utf8');
      log(logPrefix, 'Restored pnpm-workspace.yaml from backup');

      // 删除备份文件
      fs.unlinkSync(workspaceYamlBackupPath);
      return true;
    } else {
      // 文件没有被修改，删除备份文件
      fs.unlinkSync(workspaceYamlBackupPath);
      log(logPrefix, 'pnpm-workspace.yaml was not modified, backup removed');
      return false;
    }
  } catch (err) {
    log(logPrefix, `Failed to restore pnpm-workspace.yaml: ${err.message}`, 'warn');
    return false;
  }
}

module.exports = {
  backupWorkspaceYaml,
  restoreWorkspaceYaml,
};
