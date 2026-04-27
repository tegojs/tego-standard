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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const packageJsonPath = join(rootDir, 'package.json');
const versionJsonPath = join(rootDir, '.version.json');

function getBuildEnv(name) {
  return process.env[name]?.trim() || '';
}

function readFileIfExists(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

function getGitDir() {
  const defaultGitDir = join(rootDir, '.git');
  const gitPathContent = readFileIfExists(defaultGitDir);

  if (gitPathContent.startsWith('gitdir:')) {
    return join(rootDir, gitPathContent.replace(/^gitdir:\s*/, ''));
  }

  return defaultGitDir;
}

function readPackedRefs(gitDir) {
  const packedRefsPath = join(gitDir, 'packed-refs');
  const packedRefsContent = readFileIfExists(packedRefsPath);
  if (!packedRefsContent) {
    return new Map();
  }

  const refs = new Map();
  for (const line of packedRefsContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) {
      continue;
    }

    const [hash, ref] = trimmed.split(' ');
    if (hash && ref) {
      refs.set(ref, hash);
    }
  }
  return refs;
}

function resolveRefHash(refName) {
  const gitDir = getGitDir();
  const looseRefPath = join(gitDir, ...refName.split('/'));
  const looseRef = readFileIfExists(looseRefPath);
  if (looseRef) {
    return looseRef;
  }

  return readPackedRefs(gitDir).get(refName) || '';
}

function getGitHeadInfo() {
  const gitDir = getGitDir();
  const head = readFileIfExists(join(gitDir, 'HEAD'));
  if (!head) {
    return { ref: '', hash: '' };
  }

  if (head.startsWith('ref:')) {
    const ref = head.replace(/^ref:\s*/, '');
    return { ref, hash: resolveRefHash(ref) };
  }

  return { ref: '', hash: head };
}

function getGitTagFromFiles(currentHash) {
  if (!currentHash) {
    return null;
  }

  const packedRefs = readPackedRefs(getGitDir());
  for (const [ref, hash] of packedRefs.entries()) {
    if (ref.startsWith('refs/tags/') && hash === currentHash) {
      return ref.replace(/^refs\/tags\//, '');
    }
  }

  return null;
}

function getLooseTagFromFiles(currentHash) {
  if (!currentHash) {
    return null;
  }

  const gitDir = getGitDir();
  const tagsDir = join(gitDir, 'refs', 'tags');
  if (!existsSync(tagsDir)) {
    return null;
  }

  const walk = (dir, prefix = 'refs/tags') => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const refName = `${prefix}/${entry}`;

      if (statSync(fullPath).isDirectory()) {
        const nestedTag = walk(fullPath, refName);
        if (nestedTag) {
          return nestedTag;
        }
        continue;
      }

      if (readFileIfExists(fullPath) === currentHash) {
        return refName.replace(/^refs\/tags\//, '');
      }
    }

    return null;
  };

  return walk(tagsDir);
}

function getGitHash() {
  const buildHash = getBuildEnv('BUILD_GIT_HASH') || getBuildEnv('GIT_COMMIT_SHA');
  if (buildHash) {
    return buildHash.slice(0, 7);
  }

  const headInfo = getGitHeadInfo();
  if (headInfo.hash) {
    return headInfo.hash.slice(0, 7);
  }

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
  const buildBranch =
    getBuildEnv('BUILD_GIT_BRANCH') ||
    process.env.CI_COMMIT_REF_NAME ||
    process.env.GITHUB_REF_NAME ||
    process.env.GIT_BRANCH;
  if (buildBranch) {
    return buildBranch;
  }

  const headInfo = getGitHeadInfo();
  if (headInfo.ref.startsWith('refs/heads/')) {
    return headInfo.ref.replace(/^refs\/heads\//, '');
  }

  try {
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
  const buildTag = getBuildEnv('BUILD_GIT_TAG') || process.env.CI_COMMIT_TAG;
  if (buildTag) {
    return buildTag;
  }

  try {
    // 在 CI/CD 环境中，通过环境变量获取 tag
    if (process.env.GITHUB_REF_TYPE === 'tag' || getBuildEnv('BUILD_GIT_REF_TYPE') === 'tag') {
      return process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_TAG || null;
    }

    const headInfo = getGitHeadInfo();
    const looseTag = getLooseTagFromFiles(headInfo.hash);
    if (looseTag) {
      return looseTag;
    }
    const packedTag = getGitTagFromFiles(headInfo.hash);
    if (packedTag) {
      return packedTag;
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
