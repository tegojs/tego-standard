#!/usr/bin/env node

/**
 * 自动生成 CHANGELOG 脚本
 * 基于 git commits 和 conventional commits 格式生成更新日志
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// 类型映射（英文）
const TYPE_MAP_EN = {
  feat: 'Added',
  fix: 'Fixed',
  docs: 'Documentation',
  style: 'Style',
  refactor: 'Refactored',
  perf: 'Performance',
  test: 'Tests',
  build: 'Build',
  ci: 'CI',
  chore: 'Chore',
  revert: 'Reverted',
};

// 类型映射（中文）
const TYPE_MAP_ZH = {
  feat: '新增',
  fix: '修复',
  docs: '文档',
  style: '样式',
  refactor: '重构',
  perf: '性能',
  test: '测试',
  build: '构建',
  ci: 'CI',
  chore: '维护',
  revert: '回退',
};

// 获取两个版本之间的 commits
function getCommitsBetweenTags(fromTag, toTag) {
  try {
    let range;
    if (fromTag) {
      range = `${fromTag}..${toTag || 'HEAD'}`;
    } else {
      // 获取第一个 tag 到当前的所有 commits
      const firstTag = execSync('git rev-list --max-parents=0 HEAD', { encoding: 'utf-8' }).trim();
      range = `${firstTag}..${toTag || 'HEAD'}`;
    }

    const logFormat = '%H|%s|%b';
    const commits = execSync(`git log ${range} --pretty=format:"${logFormat}" --no-merges`, {
      encoding: 'utf-8',
      cwd: rootDir,
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, ...bodyParts] = line.split('|');
        const body = bodyParts.join('|').trim();
        return { hash, subject, body };
      });

    return commits;
  } catch (error) {
    console.warn('Warning: Could not get commits:', error.message);
    return [];
  }
}

// 解析 conventional commit
function parseCommit(commit) {
  const { subject, body } = commit;
  
  // 匹配格式: type(scope): description
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?: (.+)$/);
  
  if (!match) {
    return null;
  }

  const [, type, scope, description] = match;
  
  // 检查是否是 breaking change
  const isBreaking = subject.includes('!') || body.includes('BREAKING CHANGE');
  
  return {
    type: type.toLowerCase(),
    scope: scope || '',
    description: description.trim(),
    body: body.trim(),
    isBreaking,
  };
}

// 分组 commits
function groupCommits(commits) {
  const grouped = {
    feat: [],
    fix: [],
    docs: [],
    style: [],
    refactor: [],
    perf: [],
    test: [],
    build: [],
    ci: [],
    chore: [],
    revert: [],
    breaking: [],
  };

  commits.forEach((commit) => {
    const parsed = parseCommit(commit);
    if (!parsed) {
      // 未匹配的 commit 归类到 chore
      grouped.chore.push(commit.subject);
      return;
    }

    if (parsed.isBreaking) {
      grouped.breaking.push({
        ...parsed,
        full: commit.subject,
      });
    }

    const type = parsed.type;
    if (grouped[type]) {
      grouped[type].push({
        ...parsed,
        full: commit.subject,
      });
    } else {
      grouped.chore.push(commit.subject);
    }
  });

  return grouped;
}

// 生成英文 changelog 条目
function generateChangelogEntryEN(grouped, version, date) {
  const lines = [`## [${version}] - ${date}`, ''];

  // Breaking changes
  if (grouped.breaking.length > 0) {
    lines.push('### ⚠️ Breaking Changes', '');
    grouped.breaking.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Added
  if (grouped.feat.length > 0) {
    lines.push('### Added', '');
    grouped.feat.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Fixed
  if (grouped.fix.length > 0) {
    lines.push('### Fixed', '');
    grouped.fix.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Changed (refactor, perf)
  const changed = [...grouped.refactor, ...grouped.perf];
  if (changed.length > 0) {
    lines.push('### Changed', '');
    changed.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Documentation
  if (grouped.docs.length > 0) {
    lines.push('### Documentation', '');
    grouped.docs.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Other (style, test, build, ci, chore)
  const other = [
    ...grouped.style,
    ...grouped.test,
    ...grouped.build,
    ...grouped.ci,
    ...grouped.chore,
  ];
  if (other.length > 0) {
    lines.push('### Other', '');
    other.forEach((item) => {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else {
        const scope = item.scope ? `**${item.scope}**: ` : '';
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  return lines.join('\n');
}

// 生成中文 changelog 条目
function generateChangelogEntryZH(grouped, version, date) {
  const lines = [`## [${version}] - ${date}`, ''];

  // Breaking changes
  if (grouped.breaking.length > 0) {
    lines.push('### ⚠️ 破坏性变更', '');
    grouped.breaking.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Added
  if (grouped.feat.length > 0) {
    lines.push('### 新增', '');
    grouped.feat.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Fixed
  if (grouped.fix.length > 0) {
    lines.push('### 修复', '');
    grouped.fix.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Changed
  const changed = [...grouped.refactor, ...grouped.perf];
  if (changed.length > 0) {
    lines.push('### 变更', '');
    changed.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Documentation
  if (grouped.docs.length > 0) {
    lines.push('### 文档', '');
    grouped.docs.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Other
  const other = [
    ...grouped.style,
    ...grouped.test,
    ...grouped.build,
    ...grouped.ci,
    ...grouped.chore,
  ];
  if (other.length > 0) {
    lines.push('### 其他', '');
    other.forEach((item) => {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else {
        const scope = item.scope ? `**${item.scope}**: ` : '';
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  return lines.join('\n');
}

// 获取最新版本号
function getLatestVersion() {
  try {
    const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8', cwd: rootDir })
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((tag) => /^v?\d+\.\d+\.\d+/.test(tag));

    if (tags.length > 0) {
      return tags[0].replace(/^v/, '');
    }
  } catch (error) {
    console.warn('Warning: Could not get tags:', error.message);
  }

  // 从 package.json 读取
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    return pkg.version;
  } catch (error) {
    console.error('Error: Could not read package.json');
    process.exit(1);
  }
}

// 更新 CHANGELOG 文件
function updateChangelog(newVersion, fromTag = null) {
  const date = new Date().toISOString().split('T')[0];
  const commits = getCommitsBetweenTags(fromTag, `v${newVersion}`);
  
  if (commits.length === 0 && !fromTag) {
    console.log('No commits found. Skipping changelog generation.');
    return;
  }

  const grouped = groupCommits(commits);
  
  // 检查是否有实际变更
  const hasChanges = Object.values(grouped).some((items) => items.length > 0);
  if (!hasChanges) {
    console.log('No conventional commits found. Skipping changelog generation.');
    return;
  }

  const entryEN = generateChangelogEntryEN(grouped, newVersion, date);
  const entryZH = generateChangelogEntryZH(grouped, newVersion, date);

  // 更新英文 CHANGELOG
  const changelogENPath = join(rootDir, 'CHANGELOG.md');
  let changelogEN = readFileSync(changelogENPath, 'utf-8');
  
  // 在 [Unreleased] 之后插入新版本条目
  if (changelogEN.includes('## [Unreleased]')) {
    // 找到 [Unreleased] 部分的结束位置（下一个 ## 或文件末尾）
    const unreleasedIndex = changelogEN.indexOf('## [Unreleased]');
    const nextSectionIndex = changelogEN.indexOf('\n## [', unreleasedIndex + 1);
    
    if (nextSectionIndex > -1) {
      // 在下一个版本之前插入
      changelogEN = changelogEN.slice(0, nextSectionIndex) + 
                    '\n\n' + entryEN + 
                    changelogEN.slice(nextSectionIndex);
    } else {
      // 在文件末尾插入
      changelogEN = changelogEN + '\n\n' + entryEN;
    }
  } else {
    // 在文件开头插入
    changelogEN = `## [Unreleased]\n\n${entryEN}${changelogEN}`;
  }

  // 更新链接
  changelogEN = changelogEN.replace(
    /\[Unreleased\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/g,
    `[Unreleased]: https://github.com/tegojs/tego-standard/compare/v${newVersion}...HEAD`
  );
  
  // 添加新版本的链接（如果不存在）
  if (!changelogEN.includes(`[${newVersion}]:`)) {
    const linkMatch = changelogEN.match(/\[Unreleased\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/);
    if (linkMatch) {
      changelogEN = changelogEN.replace(
        linkMatch[0],
        `${linkMatch[0]}\n[${newVersion}]: https://github.com/tegojs/tego-standard/releases/tag/v${newVersion}`
      );
    }
  }

  writeFileSync(changelogENPath, changelogEN, 'utf-8');
  console.log(`✓ Updated CHANGELOG.md for version ${newVersion}`);

  // 更新中文 CHANGELOG
  const changelogZHPath = join(rootDir, 'CHANGELOG.zh-CN.md');
  let changelogZH = readFileSync(changelogZHPath, 'utf-8');
  
  // 在 [未发布] 之后插入新版本条目
  if (changelogZH.includes('## [未发布]')) {
    const unreleasedIndex = changelogZH.indexOf('## [未发布]');
    const nextSectionIndex = changelogZH.indexOf('\n## [', unreleasedIndex + 1);
    
    if (nextSectionIndex > -1) {
      changelogZH = changelogZH.slice(0, nextSectionIndex) + 
                    '\n\n' + entryZH + 
                    changelogZH.slice(nextSectionIndex);
    } else {
      changelogZH = changelogZH + '\n\n' + entryZH;
    }
  } else {
    changelogZH = `## [未发布]\n\n${entryZH}${changelogZH}`;
  }

  // 更新链接
  changelogZH = changelogZH.replace(
    /\[未发布\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/g,
    `[未发布]: https://github.com/tegojs/tego-standard/compare/v${newVersion}...HEAD`
  );
  
  // 添加新版本的链接（如果不存在）
  if (!changelogZH.includes(`[${newVersion}]:`)) {
    const linkMatch = changelogZH.match(/\[未发布\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/);
    if (linkMatch) {
      changelogZH = changelogZH.replace(
        linkMatch[0],
        `${linkMatch[0]}\n[${newVersion}]: https://github.com/tegojs/tego-standard/releases/tag/v${newVersion}`
      );
    }
  }

  writeFileSync(changelogZHPath, changelogZH, 'utf-8');
  console.log(`✓ Updated CHANGELOG.zh-CN.md for version ${newVersion}`);
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const version = args[0];
  const fromTag = args[1] || null;

  if (!version) {
    console.error('Usage: node generate-changelog.mjs <version> [fromTag]');
    console.error('Example: node generate-changelog.mjs 1.5.2 v1.5.1');
    process.exit(1);
  }

  updateChangelog(version, fromTag);
}

main();

