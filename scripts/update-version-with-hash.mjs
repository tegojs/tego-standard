#!/usr/bin/env node
/**
 * 构建时自动更新版本号脚本
 * 版本号格式：1.0.0-hash@branch
 * - 如果当前不是 tag，或 tag 不是标准版本格式，则添加 @branch
 * - 标准版本格式：v1.0.0 或 1.0.0 或 1.0.0-alpha 等
 *
 * 使用方法：
 *   node scripts/update-version-with-hash.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const packageJsonPath = join(rootDir, 'package.json');
const versionJsonPath = join(rootDir, '.version.json');

function getGitHash() {
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      encoding: 'utf-8',
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    console.warn(`⚠ Failed to get Git hash: ${error.message}`);
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
    console.warn(`⚠ Failed to get Git branch name: ${error.message}`);
    return `UnkBranch`;
  }
}

function getCurrentTag() {
  try {
    // 在 CI/CD 环境中，通过环境变量获取 tag
    if (process.env.GITHUB_REF_TYPE === 'tag') {
      return process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_TAG || null;
    }

    // 通过 Git 命令获取当前 commit 的 tag
    try {
      const tag = execSync('git describe --exact-match --tags HEAD', {
        encoding: 'utf-8',
        cwd: rootDir,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return tag || null;
    } catch {
      return null;
    }
  } catch (error) {
    return null;
  }
}

function extractBaseVersion(version) {
  // 从版本号中提取基础版本（去掉可能存在的 -hash@branch）
  // 例如：1.3.25-abc1234@develop -> 1.3.25
  return version.split('-')[0].split('@')[0];
}

function isStandardVersion(tag) {
  if (!tag) return false;
  // 检查版本号是否是标准格式：1.0.0 或 v1.0.0 等
  // 标准格式：可选 v 开头，然后是数字.数字.数字，可能还有 - 后缀（预发布版本）
  // 例如：1.0.0, v1.0.0, 1.0.0-alpha, v1.0.0-beta.1 都是标准格式
  // 但 1.0.0-abc1234 或 1.0.0-abc1234@develop 不是标准格式（有 hash 或 branch）
  const standardVersionPattern = /^(v)?\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
  return standardVersionPattern.test(tag);
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
    const currentTag = getCurrentTag();

    // 检查 tag 是否是标准版本格式
    const isTagStandard = isStandardVersion(currentTag);

    // 构建新版本号
    let newVersion = `${baseVersion}`;

    // 只要当前不是 tag，或者是 tag 但 tag 的格式不是标准版本号，就添加 @branch
    if (!isTagStandard) {
      newVersion = `${baseVersion}-${hash}@${branch}`;
    }

    // 将版本号写入独立的 .version.json 文件，而不是修改 package.json
    // 这样可以避免污染 git 状态
    const versionInfo = {
      version: newVersion,
      baseVersion,
      hash,
      branch,
      tag: currentTag,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(versionJsonPath, JSON.stringify(versionInfo, null, 2) + '\n', 'utf-8');

    if (!isTagStandard) {
      console.log(`✓ Version generated: ${baseVersion} -> ${newVersion}`);
      console.log(`  Hash: ${hash}`);
      console.log(`  Branch: ${branch}`);
      console.log(`  Version info written to: .version.json`);
    } else {
      console.log(`✓ Version: ${newVersion} (standard version tag)`);
      console.log(`  Version info written to: .version.json`);
    }

    return newVersion;
  } catch (error) {
    console.error('❌ Failed to update version:', error.message);
    // 写入版本失败后继续执行, 不中断 build 流程
  }
}

// 执行更新
updateVersion();
