#!/usr/bin/env node
/**
 * 构建时自动更新版本号脚本
 * 版本号格式：1.0.0-hash@branch（分支不是 main 时带分支名）
 * 
 * 使用方法：
 *   node scripts/update-version-with-hash.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const packageJsonPath = join(rootDir, 'package.json');

function getGitHash() {
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      encoding: 'utf-8',
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    console.warn(`⚠ 无法获取 Git hash: ${error.message}`);
    return `UnkVer`;
  }
}

function getGitBranch() {
  try {
    // 优先获取 CI/CD 环境变量中的分支名
    const ciBranch = process.env.CI_COMMIT_REF_NAME || process.env.GITHUB_REF_NAME || process.env.GIT_BRANCH;
    if (ciBranch) {
      return ciBranch;
    }
    
    // 从 Git 获取当前分支名
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    console.warn(`⚠ 无法获取 Git 分支名: ${error.message}`);
    return `UnkBranch`;
  }
}

function extractBaseVersion(version) {
  // 从版本号中提取基础版本（去掉可能存在的 -hash@branch）
  // 例如：1.3.25-abc1234@develop -> 1.3.25
  return version.split('-')[0].split('@')[0];
}

function updateVersion() {
  try {
    // 读取 package.json
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    
    // 获取基础版本号
    const baseVersion = extractBaseVersion(packageJson.version);
    
    // 获取 Git 信息
    const hash = getGitHash();
    const branch = getGitBranch();
    
    // 构建新版本号
    let newVersion = `${baseVersion}-${hash}`;
    
    // 只有当分支不是 main 时才添加 @branch
    if (branch && branch !== 'main' && branch !== 'master') {
      newVersion = `${newVersion}@${branch}`;
    }
    
    // 更新版本号
    packageJson.version = newVersion;
    
    // 写回 package.json
    writeFileSync(
      packageJsonPath,
      JSON.stringify(packageJson, null, 2) + '\n',
      'utf-8'
    );
    
    console.log(`✓ 版本号已更新: ${baseVersion} -> ${newVersion}`);
    console.log(`  Hash: ${hash}`);
    console.log(`  分支: ${branch}`);
    
    return newVersion;
  } catch (error) {
    console.error('❌ 更新版本号失败:', error.message);
    process.exit(1);
  }
}

// 执行更新
updateVersion();

